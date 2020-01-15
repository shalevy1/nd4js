'use strict';

/* This file is part of ND.JS.
 *
 * ND.JS is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * ND.JS is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License
 * along with ND.JS. If not, see <http://www.gnu.org/licenses/>.
 */

import {eps, ARRAY_TYPES} from '../dt'
import math from '../math'
import {asarray, NDArray} from '../nd_array'

import {_giv_rot_rows} from './_giv_rot'
import {FrobeniusNorm} from './norm'
import {_norm,
        _norm_update} from './rrqr'
import {_transpose_inplace} from './transpose_inplace'


export function _row_norm_update(norm, AB,AB_off, M)
{
  // https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Math/hypot#Polyfill
  AB_off |= 0;
  M <<= 1;

  for( let j=0; j < M; j+=2 ) {
    let s = Math.abs(AB[AB_off + (j>>>1)]);
    if( s !== 0 ) {
      if(         norm[j] < s ) {
        const r = norm[j] / s; norm[j+1] *= r*r;
                  norm[j] = s;
      }       s/= norm[j]
                  norm[j+1] += s*s;
    }
  }
}


export function srrqr_decomp_full( A, opt={} )
{
  // SEE: Ming Gu, Stanley C. Eisenstat,
  //     "EFFICIENT ALGORITHMS FOR COMPUTING A STRONG RANK-REVEALING QR FACTORIZATION"
  //      https://math.berkeley.edu/~mgu/MA273/Strong_RRQR.pdf

  // TODO:
  //   Instead of going through every potential rank `k`,
  //   we could use binary search to find the right rank
  //   with potentially less "strong" column swaps

  A = asarray(A)

  if( A.ndim < 2                   ) throw new Error('srrqr_decomp_full(A,opt): A must be at least 2D.');
  if( A.dtype.startsWith('complex')) throw new Error('srrqr_decomp_full(A,opt): Complex A not (yet) supported.');

   //
  //
  const
    dtype = A.dtype==='float32' ? 'float32' : 'float64',
    DTypeArray = ARRAY_TYPES[dtype],
    R_shape =                 A.shape,
    Q_shape = Int32Array.from(R_shape),
    P_shape =                 Q_shape.slice(0,-1),
    r_shape =                 R_shape.slice(0,-2),
                      [M,N] = R_shape.slice(  -2),
       L    = Math.min(M,N); // <- M not M-1, because the last row still needs pivotization
  Q_shape[Q_shape.length-1] = M;
  P_shape[P_shape.length-1] = N;

  const R = DTypeArray.from(A.data); A = undefined;
  const r = new Int32Array(R.length/N/M),
        P = new Int32Array(R.length/M), // <- tracks column permutations
        Q = new DTypeArray(R.length/N*M),
      AB  = new DTypeArray(M*N), // <- stores inv(A) and A\B in COLUMN MAJOR order
      AB0 = new DTypeArray(M*N),
     norm = new DTypeArray(N<<1),
     NORM = new FrobeniusNorm(); // <─ underflow-safe representation of the column norm

  for( let i=r.length; i-- > 0; )
    r[i] = Math.random()*1024 - 1024;

  let ztol = NaN,
      dtol = NaN;

  let Q_dirty = false;

  let Q_off=0,
      R_off=0,
      P_off=0;

  let k0= 0,
      k = 0,
      K = 0;

  // PROCESS THE (TOLERANCE) OPTIONS
  const [DTOL,ZTOL] = function(){
    let {
      dtol = 1.01,
      ztol = undefined
    } = opt;

    if( dtol instanceof NDArray )
    {
      throw new Error(`srrqr_decomp_full(A,opt): NDArray as opt.dtol not yet supported.`);
    }
    else
    {
      if(!(dtol >=1)) throw new Error(`srrqr_decomp_full(A,opt): Invalid opt.dtol: ${dtol}. Must be >=1.`);
      const        DTOL = Number(dtol);
      dtol = () => DTOL;
    }

    if( ztol instanceof NDArray )
    {
      throw new Error(`srrqr_decomp_full(A,opt): NDArray as opt.ztol not yet supported.`);
    }
    else if( null == ztol ) {
      const _eps = Math.sqrt(eps(dtype));

      ztol = i => {
                  i*= M*N;
        const I = i + M*N; NORM.reset();
        for(; i < I; i++ ) NORM.include(R[i]);
        return      _eps * NORM.result * Math.max(M,N); // <- should be a little stricter than rrqr_rank such they work well together
      };
    }
    else
    {
      if(!(ztol >=0)) throw new Error(`srrqr_decomp_full(A,opt): invalid opt.ztol: ${ztol}. Must be non-negative number.`);
      const        ZTOL = Number(ztol);
      ztol = () => ZTOL;
    }

    return [dtol,ztol];
  }();
  opt = undefined;


  const update = (AB,k) =>
  {
//*DEBUG*/    // CHECK TRIANGULARITY OF R AND AB
//*DEBUG*/    for( let j=0;   j < k; j++)
//*DEBUG*/    for( let i=j; ++i < M;    )
//*DEBUG*/    {
//*DEBUG*/      if( !(R [R_off + N*i+j  ] === 0) ) throw new Error(`Assertion failed.`);
//*DEBUG*/      if( !(AB[          i+j*M] === 0) ) throw new Error(`Assertion failed.`);
//*DEBUG*/    }

    // UPDATE inv(A)
    { const                                   R_kk = - R[R_off + N*k+k];
                               AB[k+k*M]=-1 / R_kk;
      for( let i=k; i-- > 0; ) AB[i+k*M]    /=R_kk;
    }
    // UPDATE A\B
    for( let j=k; ++j <  N;     )
    for( let i=0;   i <= k; i++ )
      AB[i+j*M] += AB[i+k*M] * R[R_off + N*k+j];
  }


  const downdate = (AB,k) =>
  {
//*DEBUG*/    // CHECK TRIANGULARITY OF R AND AB
//*DEBUG*/    for( let j=0;   j < k; j++)
//*DEBUG*/    for( let i=j; ++i < M;    )
//*DEBUG*/    {
//*DEBUG*/      if( !(R [R_off + N*i+j  ] === 0) ) throw new Error(`Assertion failed.`);
//*DEBUG*/      if( !(AB[          i+j*M] === 0) ) throw new Error(`Assertion failed.`);
//*DEBUG*/    }

    // DOWNDATE A\B
    for( let j=N; --j   > k; ) { AB[k+j*M]  = 0;
    for( let i=k;   i-- > 0; )   AB[i+j*M] -= AB[i+k*M] * R[R_off + N*k+j]; }
    // DOWNDATE inv(A)
    AB[k+k*M] = 0;
    { const                                 R_kk = - R[R_off + N*k+k];
      for( let i=k; i-- > 0; ) AB[i+k*M] *= R_kk;
    }
  }


  const swap_elim = p =>
  {
    // swap columns in R
    for( let j=0; j < M; j++ ) {
      const R_jk = R[R_off + N*j+k];
                   R[R_off + N*j+k] = R[R_off + N*j+p];
                                      R[R_off + N*j+p] = R_jk;
    }
    // swap columns in A\B (which is column major)
    for( let j=0; j < k; j++ ) {
      const AB_jk = AB0[j+k*M];
                    AB0[j+k*M] = AB0[j+p*M];
                                 AB0[j+p*M] = AB_jk;
    }
    for( let j=0; j < k; j++ ) {
      const AB_jk = AB[j+k*M];
                    AB[j+k*M] = AB[j+p*M];
                                AB[j+p*M] = AB_jk;
    }
    // swap P
    const P_i = P[P_off+k];
                P[P_off+k] = P[P_off+p];
                             P[P_off+p] = P_i;

    // RESET COLUMN NORM (INDEX k IS SET TO ZERO FOR THE NEXT RRQR)
    norm.fill(0.0);

    // ELIMINATE COLUMN k BELOW DIAGONAL (USING GIVEN ROTATIONS)
    let count = 0;
    for( let j=k; ++j < M; )
    { const       kk = R_off + N*k+k,
                  jk = R_off + N*j+k,
                R_jk = R[jk];
      if( 0 !== R_jk )
      {   const R_kk = R[kk],
                       norm = Math.hypot(R_kk,R_jk),
            c = R_kk / norm,
            s = R_jk / norm; R[jk] = 0;
        if( s !== 0 ) {      R[kk] = norm;
          _giv_rot_rows(R, N-1-k, kk+1,
                                  jk+1, c,s);
          _giv_rot_rows(
            Q,
            Q_dirty ? M : j+1, // <- "strong" column swaps "contaminate" Q -> be fully rotate
            Q_off + M*k,
            Q_off + M*j, c,s
          );
        }
      }
      _norm_update(norm, R, R_off + N*j, k+1);
    }
  }


  const piv_elim = () =>
  {
//*DEBUG*/    check_col_norms();

    let    p = -1,
      norm_p = -Infinity;
    for( let j=k; j < N; j++ ) {
      const  norm_j =_norm(norm,j);
      if(    norm_p < norm_j ) {
        p=j; norm_p = norm_j
      }
    }

//*DEBUG*/    if(!(norm_p >= 0))
//*DEBUG*/      throw new Error('Assertion failed.');

    swap_elim(p);
  }


//*DEBUG*/  const check = (AB, k) =>
//*DEBUG*/  {
//*DEBUG*/    // check inv(A)
//*DEBUG*/    for( let i=0; i < k; i++ )
//*DEBUG*/    for( let j=0; j < k; j++ )
//*DEBUG*/    {
//*DEBUG*/      let sum = 0;
//*DEBUG*/      for( let h=0; h < k; h++ )
//*DEBUG*/        sum += AB[i+h*M] * R[R_off + N*h+j];
//*DEBUG*/      if( ! (Math.abs(sum - (i===j)) <= 1e-4) )
//*DEBUG*/        throw new Error(`${sum} != ${(i===j)*1}.`);
//*DEBUG*/    }
//*DEBUG*/    // check A\B
//*DEBUG*/    for( let i=0; i < k; i++ )
//*DEBUG*/    for( let j=k; j < N; j++ )
//*DEBUG*/    {
//*DEBUG*/      let sum = 0;
//*DEBUG*/      for( let h=0; h < k; h++ )
//*DEBUG*/        sum += AB[i+h*M] * R[R_off + N*h+j];
//*DEBUG*/      if( ! (Math.abs(sum - AB[i+j*M]) <= 1e-4) )
//*DEBUG*/        throw new Error(`${sum} != ${AB[i+j*M]}.`);
//*DEBUG*/    }
//*DEBUG*/  }
//*DEBUG*/
//*DEBUG*/
//*DEBUG*/  const check_col_norms = () =>
//*DEBUG*/  {
//*DEBUG*/    for( let j=k; j < N; j++ )
//*DEBUG*/    {
//*DEBUG*/      const nj = _norm(norm, j),
//*DEBUG*/            uj = Math.hypot(...function*(){
//*DEBUG*/              for( let i=k; i < M; i++ )
//*DEBUG*/                yield R[R_off + N*i+j];
//*DEBUG*/            }());
//*DEBUG*/      if( !(Math.abs(nj-uj) <= 1e-8) )
//*DEBUG*/        throw new Error('Assertion failed.');
//*DEBUG*/    }
//*DEBUG*/  }


  const copy = (AB_src, AB_dst) =>
  {
    for( let j=0; j < N; j++ )
    for( let i=0; i < k; i++ )
      AB_dst[i+j*M] = AB_src[i+j*M];
  }


  const cycle = (AB,p,k) =>
  { for( let j=p; j < N; j++ ) { const                        AB_pj = AB[p+j*M];
      if(j < k){for( let i=p; i < j; i++ ) AB[i+j*M] = AB[(i+1)+j*M]; AB[j+j*M] = 0; }
      else      for( let i=p; i < k; i++ ) AB[i+j*M] = AB[(i+1)+j*M]; AB[k+j*M] = AB_pj;
    }
  }


  const update_col_norms = () =>
  {
    norm.fill(0.0);
    for( let i=k; i < M; i++ )
      _norm_update(norm, R, R_off + N*i, k);
  }


  const rest_norm = () =>
  {
//*DEBUG*/    check_col_norms();

    NORM.reset();
    for( let j=k; j < N; j++ )
      NORM.include(_norm(norm,j) );
    return NORM.result;
  }

  const adjust_k = increase =>
  {
//*DEBUG*/    if( 'boolean' !== typeof increase )
//*DEBUG*/      throw new Error('Assertion failed.');
//*DEBUG*/    if(!(k0 <= k     )) throw new Error('Assertion failed.');
//*DEBUG*/    if(!(      k <= K)) throw new Error('Assertion failed.');

//*DEBUG*/    check_col_norms();

    if(increase)
    {
//*DEBUG*/      if(!(k < K)) throw new Error('Assertion failed.');
      piv_elim();
      update(AB, k++);
      copy(AB,AB0);
      k0 = k;
    }
    else
    {
//*DEBUG*/      if(!(k0 < k)) throw new Error('Assertion failed.');
//*DEBUG*/      if(!(K == k)) throw new Error('Assertion failed.');
      copy(AB0,AB);
      k = k0;
      update_col_norms();
    }

    let mid = k0+K >>> 1;

    while( k < mid )
    {
//*DEBUG*/      check_col_norms();

      if( rest_norm() <= ztol )
      { K = k;
        if( k0 < k )
        { copy(AB0,AB);
          k = k0;
          update_col_norms();

          mid = k0+K >>> 1;
          increase = false;
          continue;
        }
        break;
      }

      if(increase)
        piv_elim();

      update(AB, k++);

      if(!increase)
        update_col_norms();

//*DEBUG*/      check_col_norms();
    }
  }


//*DEBUG*/  const logdet_A = () =>
//*DEBUG*/  {
//*DEBUG*/    // CHECK TRIANGULARITY OF R AND AB
//*DEBUG*/    for( let j=0;   j < k; j++)
//*DEBUG*/    for( let i=j; ++i < M;    )
//*DEBUG*/      if( !(R [R_off + N*i+j  ] === 0) ) throw new Error(`Assertion failed.`);
//*DEBUG*/
//*DEBUG*/    let logdet_A = 0;
//*DEBUG*/    for( let i=0; i < k; i++ )
//*DEBUG*/      logdet_A += Math.log2(Math.abs(R[R_off + N*i+i]));
//*DEBUG*/    return logdet_A;
//*DEBUG*/  };


  // FOR EACH MATRIX IN THE BATCH
  for(
    let r_off=0; Q_off < Q.length; Q_off += M*M,
                                   R_off += M*N,
                                   P_off +=   N,
                                   r_off += 1
  )
  {
    // INIT P
    for( let i=0; i < N; i++ ) P[P_off + i] = i;

    // INIT Q (TO IDENTITY)
    for( let i=0; i < M; i++ ) Q[Q_off + M*i+i] = 1;

    // INIT AB
    AB0.fill(0.0);
    AB .fill(0.0);

    // RETRIEVE TOLERANCES
    dtol = DTOL(r_off),
    ztol = ZTOL(r_off);
    if( !(dtol >=1) ) throw new Error('Assertion failed.');
    if( !(ztol >=0) ) throw new Error('Assertion failed.');

    // INIT BINARY SEARCH BOUNDS
    k0 = k = 0;
    K  = L;

    Q_dirty = false;
    update_col_norms();

    loop:for(;;)
    {
//*DEBUG*/      check(AB, k );
//*DEBUG*/      check(AB0,k0);
//*DEBUG*/      if(!(k0 <= k)) throw new Error('Assertion failed.');
//*DEBUG*/      if(!(   k<=N)) throw new Error('Assertion failed.');

      if( rest_norm() <= ztol )
      {
        K = k;
        if( k0 < k )
        {
          adjust_k(/*increase=*/false);
//*DEBUG*/          check(AB, k );
//*DEBUG*/          check(AB0,k0);
        }
        else if( k === N ) break loop;
//*DEBUG*/        else if( k !== k0) throw new Error('Assertion failed.');
      }

      // SEARCH BEST COLUMN SWAPS
      let p = -1,
          q = -1,
          F = -Infinity;

      // COMPUTE ROW NORMS OF inv(A)
      for( let j=0; j < k; j++ )
        _row_norm_update(norm, AB, j*M, j+1);

      // FIND BEST "STRONG" COLUMN SWAP
      for( let i=0; i < k; i++ ) { const r = _norm(norm,i);
      for( let j=k; j < N; j++ ) { const c = _norm(norm,j);
        const   f = Math.hypot( AB[i+j*M], r*c );
        if( F < f )
          [F,p,q] = [f,i,j];
      }}

      // IF NO GOOD COLUMN SWAP IS FOUND ANYMORE
      if( !(F > dtol) )
      {
        if( k0 >= K )
        {
//*DEBUG*/          if( k0 !== K ) throw new Error('Assertion failed.');
//*DEBUG*/          if( k0 !== k ) throw new Error('Assertion failed.');
          break loop;
        }
        else {
//*DEBUG*/          if(!(k < K))
//*DEBUG*/            throw new Error('Assertion failed.');
          adjust_k(/*increase=*/true);
          continue loop;
        }
      }

//*DEBUG*/      if( !(0 < k) )
//*DEBUG*/        throw new Error('Assertion failed.');

      Q_dirty = true;

//*DEBUG*/      const predict_logdet_A = logdet_A() + Math.log2(F);

      // IF inv(A0) IS AFFECTED BY COLUMN SWAP
      if( p < k0 )
      { --k0;

        // MOVE COLUMN p TO k0 (VIA CYCLIC PERMUTATION) TODO use triangulary property to reduces Ops
        // CYCLE COLUMNS of R
        for( let i=0; i <= k0; i++ ) { const                     R_ip = R[R_off + N*i+p ];
          for( let j=Math.max(p,i-1); j < k0; j++ ) R[R_off + N*i+j ] = R[R_off + N*i+(j+1)];
                                                    R[R_off + N*i+k0] = R_ip;
        }
        // CYCLE ROWS OF inv(A)
        cycle(AB, p,k0);
        cycle(AB0,p,k0);
        // CYCLE P P
        { const                                 P_p = P[P_off + p];
          for( let j=p; j < k0; j++ ) P[P_off + j ] = P[P_off + j+1];
                                      P[P_off + k0] = P_p;
        }

        // RETRIANGULATE USING GIVENS ROTATIONS
        // (since cyclic permutation turned R from triangular to Hessenberg)
        for( let i=p; i < k0; i++ )
        { const       ii = R_off + N* i   +i,
                      ji = R_off + N*(i+1)+i,
                    R_ji = R[ji];
          if( 0 !== R_ji )
          {   const R_ii = R[ii],
                           norm = Math.hypot(R_ii,R_ji),
                c = R_ii / norm,
                s = R_ji / norm; R[ji] = 0;
            if( s !== 0 ) {      R[ii] = norm;
              _giv_rot_rows(R, N-1-i, ii+1,
                                      ji+1,        c,s);
              _giv_rot_rows(Q, M, Q_off + M* i,
                                  Q_off + M*(i+1), c,s);
              _giv_rot_rows(AB, i+1,      M* i,
                                          M*(i+1), c,s); AB [k0+(i+1)*M] = -s*AB [k0+i*M] + c*AB [k0+(i+1)*M];
              _giv_rot_rows(AB0,i+1,      M* i,
                                          M*(i+1), c,s); AB0[k0+(i+1)*M] = -s*AB0[k0+i*M] + c*AB0[k0+(i+1)*M];
            }
          } AB [k0+i*M] = 0;
            AB0[k0+i*M] = 0;
        }

        downdate(AB0,k0);
        p = k0++;
      }

      --k; // <- go back one step since the swappend column needs retriangulation

      // MOVE COLUMN p TO k (VIA CYCLIC PERMUTATION) TODO use triangulary property to reduces Ops
      // CYCLE COLUMNS of R
      for( let i=0; i <= k; i++ ) { const R_ip = R[R_off + N*i+p];
        for( let j=Math.max(p,i-1); j < k; j++ ) R[R_off + N*i+j] = R[R_off + N*i+(j+1)];
                                                 R[R_off + N*i+k] = R_ip;
      }
      // CYCLE ROWS OF inv(A)
      cycle(AB, p,k);
      // CYCLE COLS OF inv(A0)
      for( let i=0; i < k0; i++ ) norm[i] = AB0[i+p*M];
      for( let j=p; j < k ; j++ )
      for( let i=0; i < k0; i++ )           AB0[i+j*M] = AB0[i+(j+1)*M];
      for( let i=0; i < k0; i++ )           AB0[i+k*M] = norm[i];
      // CYCLE P P
      { const                P_p = P[P_off + p];
        for( let j=p; j < k; j++ ) P[P_off + j] = P[P_off + j+1];
                                   P[P_off + k] = P_p;
      }

      // RETRIANGULATE USING GIVENS ROTATIONS
      // (since cyclic permutation turned R from triangular to Hessenberg)
      for( let i=p; i < k; i++ )
      { const       ii = R_off + N* i   +i,
                    ji = R_off + N*(i+1)+i,
                  R_ji = R[ji];
        if( 0 !== R_ji )
        {   const R_ii = R[ii],
                         norm = Math.hypot(R_ii,R_ji),
              c = R_ii / norm,
              s = R_ji / norm; R[ji] = 0;
          if( s !== 0 ) {      R[ii] = norm;
            _giv_rot_rows(R, N-1-i, ii+1,
                                    ji+1,        c,s);
            _giv_rot_rows(Q, M, Q_off + M* i,
                                Q_off + M*(i+1), c,s);
            _giv_rot_rows(AB,i+1,       M* i,
                                        M*(i+1), c,s);
            // rotate last row of inv(A)
            AB[k+(i+1)*M] = -s*AB[k+i*M] + c*AB[k+(i+1)*M];
          }
        }   AB[k+ i   *M] = 0; // <- aside from rounding errors, inv(A) is going to be triangular again
      }

      downdate(AB,k);
      swap_elim(q);

      if( p < k0 )
      {
//*DEBUG*/        if(!(p === k0-1)) throw new Error('Assertion failed.');
        update(AB0,p);
      }

      update(AB, k++);

//*DEBUG*/      check(AB, k );
//*DEBUG*/      check(AB0,k0);
//*DEBUG*/      // CHECK DET PREDICTION
//*DEBUG*/      if( !(Math.abs(logdet_A() - predict_logdet_A) <= 1e-6) )
//*DEBUG*/        throw new Error(`${logdet_A()} != ${predict_logdet_A}`); 
    }
    r[r_off] = k;
    _transpose_inplace(M, Q,Q_off);
  }

  return [
    new NDArray(Q_shape, Q),
    new NDArray(R_shape, R),
    new NDArray(P_shape, P),
    new NDArray(r_shape, r)
  ];
}
