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

import {asarray, NDArray} from '../nd_array'
import {eps, ARRAY_TYPES} from '../dt'
import math from '../math'
import {unpermute_rows} from './permute'
import {SingularMatrixSolveError} from './singular_matrix_solve_error'


export function _rrqr_rank(M,N, R,R_off, tmp)
{
  // SEE: Gene H. Golub, Charles F. Van Golub
  //      "Matrix Computations", 4th edition
  //      Page 276f, Chap. 5.4.2 (QR with Column Pivoting) & 5.4.3 (Numerical Rank and AΠ=QR)
  const L = Math.min(M,N)
  if( ! (tmp.length >= L) ) throw new Error('Assertion failed.')

  let sum=0,
      max=0

  for( let i=L; i-- > 0; )
  {
    for( let j=N; j-- > i; )
    {
      const elem = math.abs( R[R_off + N*i+j] );
      if(   elem != 0 ) { // <- handles NaN (by making the result NaN)
        if( elem > max ) {
          sum *= (max/elem)**2; max = elem
        } sum += (elem/max)**2
      }
    }

    tmp[i] = Math.sqrt(sum)*max
    if( ! isFinite(tmp[i]) )
      throw new Error('Infinity or NaN encountered during rank estimation.')
  }

  const dtype = tmp instanceof Float32Array ? 'float32' : 'float64',
            T = math.sqrt(eps(dtype)) * tmp[0] // <- threshold

  let r=L
  while( r > 0 && tmp[r-1] <= T ) // <- TODO use binary search here for slightly improved performance
    --r

  return r
}


export function rrqr_decomp_full(A)
{
  A = asarray(A)
  if( A.ndim < 2 ) throw new Error('A must be at least 2D.')
  const
    DTypeArray = ARRAY_TYPES[A.dtype==='float32' ? 'float32' : 'float64'], // <- ensure at least double precision
    R_shape =                 A.shape,
    Q_shape = Int32Array.from(R_shape),
    P_shape =                 Q_shape.slice(0,-1),
    [M,N]   =                 R_shape.slice(  -2);
  Q_shape[Q_shape.length-1] = M;
  P_shape[P_shape.length-1] = N;

  const R = DTypeArray.from(A.data); // <- we could encourage GC by setting `A = undefined` after this line
  A = undefined
  const
    norm_sum = new DTypeArray(N), // <─┬─ underflow-safe representation of the column norm
    norm_max = new DTypeArray(N), // <─╯  (https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Math/hypot#Polyfill)
    P = new Int32Array(R.length/M), // <- tracks column permutations
    Q = new DTypeArray(R.length/N*M)
  const norm = i => {
    if( i <  0 ) throw new Error('Assertion failed.')
    if( i >= N ) throw new Error('Assertion failed.')
    let max = norm_max[i];
    return isFinite(max) ? Math.sqrt(norm_sum[i])*max : max;
  }
  const norm_update = (k,s) => {
    if( k <  0 ) throw new Error('Assertion failed.')
    if( k >= N ) throw new Error('Assertion failed.')
    s = math.abs(s)
    if(   s > 0 ) {
      if( s > norm_max[k] ) {
        norm_sum[k] *= (norm_max[k]/s)**2
        norm_max[k] = s
      }
      norm_sum[k] += (s/norm_max[k])**2
    }
  }

  for(
    let Q_off=0,
        R_off=0,
        P_off=0; Q_off < Q.length; Q_off += M*M,
                                   R_off += M*N,
                                   P_off +=   N
  )
  {
    // INIT P
    for( let i=0; i < N; i++ ) P[P_off + i] = i;

    // INIT Q (TO IDENTITY)
    for( let i=0; i < M; i++ ) Q[Q_off + M*i+i] = 1;

    if( ! norm_sum.every(s => s===0) ) throw new Error('Assertion failed.')
    if( ! norm_max.every(m => m===0) ) throw new Error('Assertion failed.')

    // COMPUTE COLUMN NORM
    // (https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Math/hypot#Polyfill)
    for( let j=0; j < M; j++ )
    for( let k=0; k < N; k++ )
      norm_update(k, R[R_off + N*j+k])

    // ELIMINATE COLUMN BY COLUMN OF R (WHICH IS CURRENTLY STORED IN Q)
    for( let i=0; i < N; i++ )
    { // FIND PIVOT COLUMN THAT (HOPEFULLY) ENSURES RANK REVEAL (RRQR is inherently not guaranteed to do that)
      let p = i
      for( let j=i; ++j < N; )
        if( norm(j) > norm(p) ) { p = j }
      // swap pivot to column i
      if( p !== i ) {
        for( let j=0; j < M; j++ ) {
          const ji = R_off + N*j+i,
                jp = R_off + N*j+p, R_ji = R[ji];
                                           R[ji] = R[jp];
                                                   R[jp] = R_ji
        }
        const P_i = P[P_off+i];
                    P[P_off+i] = P[P_off+p];
                                 P[P_off+p] = P_i
      }

      // RESET COLUMN NORM (INDEX i IS SET TO ZERO FOR THE NEXT RRQR)
      norm_sum.fill(0.0, i)
      norm_max.fill(0.0, i)

      // ELIMINATE ENTRIES BELOW DIAGONAL
      for( let j=i; ++j < M; )
      { // compute Given's rotation 
        const R_ji = R[R_off + N*j+i];
        if( R_ji == 0.0 ) {
          for( let k=i; ++k < N; )
            norm_update(k, R[R_off + N*j+k])
          continue
        }
        const R_ii = R[R_off + N*i+i],
                     norm = Math.hypot(R_ii,R_ji),
          c = R_ii / norm,
          s = R_ji / norm;
        R[R_off + N*i+i] = norm;
        R[R_off + N*j+i] = 0.0;

        // ROTATE i AND j IN R
        for( let k=i; ++k < N; ) {
          // Given's rotation
          const jk = R_off + N*j+k, R_jk = R[jk],
                ik = R_off + N*i+k, R_ik = R[ik];
          R[jk] = c*R_jk - s*R_ik;
          R[ik] = s*R_jk + c*R_ik;
          // re-compute column norm
          norm_update(k, R[jk])
        }

        // ROTATE i AND j IN Q
        for( let k=0; k <= j; k++ ) {
          const jk = Q_off + M*j+k, Q_jk = Q[jk],
                ik = Q_off + M*i+k, Q_ik = Q[ik];
          Q[jk] = c*Q_jk - s*Q_ik;
          Q[ik] = s*Q_jk + c*Q_ik;
        }
      }
    }

    // TRANSPOSE Q
    for( let i=0; i < M; i++ )
    for( let j=0; j < i; j++ )
    {
      const ji = Q_off + M*j+i,
            ij = Q_off + M*i+j,
          Q_ij = Q[ij];
                 Q[ij] = Q[ji];
                         Q[ji] = Q_ij
    }
  }

  return [
    new NDArray(Q_shape, Q),
    new NDArray(R_shape, R),
    new NDArray(P_shape, P)
  ];
}


export function rrqr_decomp(A)
{
  // TODO: implement Strong RRQR as well, e.g. as la.rrqr_decomp_strong 
  // SEE: Ming Gu, Stanley C. Eisenstat,
  //     "EFFICIENT ALGORITHMS FOR COMPUTING A STRONG RANK-REVEALING QR FACTORIZATION"
  //      https://math.berkeley.edu/~mgu/MA273/Strong_RRQR.pdf

  A = asarray(A)
  if( A.ndim < 2 ) throw new Error('A must be at least 2D.')
  const
    DTypeArray = ARRAY_TYPES[A.dtype==='float32' ? 'float32' : 'float64'], // <- ensure at least double precision
    Q_shape =                 A.shape,
    R_shape = Int32Array.from(Q_shape),
    P_shape =                 Q_shape.slice(0,-1),
    [N,M]   =                 Q_shape.slice(  -2);
  R_shape[R_shape.length-2] = M;
  P_shape[P_shape.length-1] = M;

  if( N <= M ) return rrqr_decomp_full(A)

  const Q = DTypeArray.from(A.data); // <- we could encourage GC by setting `A = undefined` after this line
  A = undefined
  const
    norm_sum = new DTypeArray(M), // <─┬─ underflow-safe representation of the column norm
    norm_max = new DTypeArray(M), // <─╯  (https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Math/hypot#Polyfill)
    P = new Int32Array(Q.length/N), // <- tracks column permutations
    R = new DTypeArray(Q.length/N*M),
    cs= new DTypeArray( 2*N*M - M*(M+1) )// <- cache cos() and sin() values to apply M column rotations to Q at once
  const norm = i => {
    let max = norm_max[i];
    return isFinite(max) ? Math.sqrt(norm_sum[i])*max : max;
  }
  const norm_update = (k,s) => {
    s = math.abs(s)
    if(   s > 0 ) {
      if( s > norm_max[k] ) {
        norm_sum[k] *= (norm_max[k]/s)**2
        norm_max[k] = s
      }
      norm_sum[k] += (s/norm_max[k])**2
    }
  }

  for(
    let Q_off=0,
        R_off=0,
        P_off=0; Q_off < Q.length; Q_off += N*M,
                                   R_off += M*M,
                                   P_off +=   M
  )
  {
    // INIT P
    for( let i=0; i < M; i++ ) P[P_off + i] = i;

//    if( ! norm_sum.every(s => s===0) ) throw new Error('Assertion failed.')
//    if( ! norm_max.every(m => m===0) ) throw new Error('Assertion failed.')

    // COMPUTE COLUMN NORM
    // (https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Math/hypot#Polyfill)
    for( let j=0; j < N; j++ )
    for( let k=0; k < M; k++ )
      norm_update(k, Q[Q_off + M*j+k])

    let csi = 0;
    // ELIMINATE COLUMN BY COLUMN OF R (WHICH IS CURRENTLY STORED IN Q)
    for( let i=0; i < M; i++ )
    { // FIND PIVOT COLUMN THAT (HOPEFULLY) ENSURES RANK REVEAL (RRQR is inherently not guaranteed to do that)
      let p = i
      for( let norm_p = norm(p), j=i; ++j < M; )
      { const  norm_j = norm(j)
        if( norm_j > norm_p ) {
          p = j
          norm_p = norm_j
        }
      }
      // swap pivot to column i
      if( p !== i ) {
        for( let j=0; j < N; j++ ) {
          const ji = Q_off + M*j+i,
                jp = Q_off + M*j+p, A_ji = Q[ji];
                                           Q[ji] = Q[jp];
                                                   Q[jp] = A_ji
        }
        const P_i = P[P_off+i];
                    P[P_off+i] = P[P_off+p];
                                 P[P_off+p] = P_i
      }

      // RESET COLUMN NORM (INDEX i IS SET TO ZERO FOR THE NEXT RRQR)
      norm_sum.fill(0.0, i)
      norm_max.fill(0.0, i)

      // ELIMINATE ENTRIES BELOW DIAGONAL
      for( let j=i; ++j < N; )
      { // compute Given's rotation 
        const A_ji = Q[Q_off + M*j+i];
        if( A_ji == 0.0 ) {
          cs[csi++]=1.0
          cs[csi++]=0.0
          for( let k=i; ++k < M; )
            norm_update(k, Q[Q_off + M*j+k])
          continue
        };
        const A_ii = Q[Q_off + M*i+i],
                     norm = Math.hypot(A_ii,A_ji),
          c = A_ii / norm,
          s = A_ji / norm;
        Q[Q_off + M*i+i] = norm;
        Q[Q_off + M*j+i] = 0.0;
        // rotate i and j
        for( let k=i; ++k < M; ) {
          // Given's rotation
          const jk = Q_off + M*j+k; {
          const ik = Q_off + M*i+k, 
              A_ik = Q[ik],
              A_jk = Q[jk];
            Q[jk] = c*A_jk - s*A_ik;
            Q[ik] = s*A_jk + c*A_ik;
          }
          // re-compute column norm
          norm_update(k, Q[jk])
        }
        cs[csi++] = c;
        cs[csi++] = s;
      }
    }

    if( csi != cs.length ) throw new Error('Assertion failed!')

    // MOVE R FROM Q -> R
    for( let i=0; i < M; i++ )
    for( let j=i; j < M; j++ ) {
      R[R_off + M*i+j] = Q[Q_off + M*i+j];
                         Q[Q_off + M*i+j] = i !== j ? 0.0 : 1.0
    }

    // COMPUTE Q
    for( let i=M; i-- > 0; )
    for( let j=N; --j > i; )
    {
      const s = cs[--csi],
            c = cs[--csi];
      for( let k=M; k-- > i;) {
        // Given's rotation
        const jk = Q_off + M*j+k; {
        const ik = Q_off + M*i+k, 
            A_ik = Q[ik],
            A_jk = Q[jk];
          Q[jk] = s*A_ik + c*A_jk;
          Q[ik] = c*A_ik - s*A_jk;
        }
      }
    }

    if( csi != 0 ) throw new Error('Assertion failed!')
  }

  return [
    new NDArray(Q_shape, Q),
    new NDArray(R_shape, R),
    new NDArray(P_shape, P)
  ];
}


export function rrqr_rank(R)
{
  R = asarray(R)
  const [M,N] = R.shape.slice(  -2),
      r_shape = R.shape.slice(0,-2)
  R = R.data
  const r = new ARRAY_TYPES['int32'](R.length/M/N),
      tmp = new ARRAY_TYPES[R.dtype==='float32' ? 'float32' : 'float64']( Math.min(M,N) )

  for( let r_off=0,
           R_off=0; r_off < r.length;
           r_off ++,
           R_off += M*N )
    r[r_off] = _rrqr_rank(M,N, R,R_off, tmp)

  return new NDArray(r_shape, r)
}


export function rrqr_solve(Q,R,P, y)
{
  Q = asarray(Q)
  R = asarray(R)
  const N = Q.shape[Q.ndim-2]
  if( N !== R.shape[R.ndim-1] )
    throw new Error('rrqr_solve(Q,R,P, y): Q @ R not square.')

  const x = rrqr_lstsq(Q,R,P, y),
      tmp = new ARRAY_TYPES[R.dtype==='float32' ? 'float32' : 'float64'](N)

  for( let R_off = 0;
           R_off < R.data.length;
           R_off += N*N )
  {
    const rank = _rrqr_rank(N,N, R.data,R_off, tmp)
    if( rank < N )
      throw new SingularMatrixSolveError(x)
  }

  return x
}


export function rrqr_lstsq(Q,R,P, y)
{
  if( y == undefined )
  {
    if( P != undefined )
      throw new Error('rrqr_lstsq(Q,R,P, y): Either 2 ([Q,R,P], y) or 4 arguments (Q,R,P, y) expected.')
    y = R
    [Q,R,P] = Q
  }

  Q = asarray(Q); if( Q.ndim < 2 ) throw new Error('rrqr_lstsq(Q,R,P, y): Q.ndim must be at least 2.')
  R = asarray(R); if( R.ndim < 2 ) throw new Error('rrqr_lstsq(Q,R,P, y): R.ndim must be at least 2.')
  P = asarray(P); if( P.ndim < 1 ) throw new Error('rrqr_lstsq(Q,R,P, y): P.ndim must be at least 1.')
  y = asarray(y); if( y.ndim < 2 ) throw new Error('rrqr_lstsq(Q,R,P, y): y.ndim must be at least 2.')
  if( P.dtype !== 'int32' ) throw new Error('rrqr_lstsq(Q,R,P, y): P.dtype must be "int32".')

  //  ________________   ______                   ___________
  // |                | |\(MxI)|                 |           |
  // |                | | \ R  |  ___________    |           |
  // |     (NxM)      | |  \   | |   (IxJ)   |   |   (NxJ)   |
  // |       Q        | |   \  | |     X     | = |     Y     |
  // |                | |    \ | |           |   |           |
  // |                | |     \| |___________|   |           |
  // |                | |  0   |                 |           |
  // |________________| |______|                 |___________|
  const
    [N,M] = Q.shape.slice(-2),
    [I]   = R.shape.slice(-1),
    [J]   = y.shape.slice(-1)
  if( N != y.shape[y.ndim-2] ) throw new Error("rrqr_lstsq(Q,R,P,y): Q and y don't match.")
  if( M != R.shape[R.ndim-2] ) throw new Error("rrqr_lstsq(Q,R,P,y): Q and R don't match.")
  if( I != P.shape[P.ndim-1] ) throw new Error("rrqr_lstsq(Q,R,P,y): R and P don't match.")

  const ndim = Math.max(Q.ndim, R.ndim, P.ndim+1, y.ndim),
       shape = Int32Array.from({length: ndim}, () => 1);
  shape[ndim-2] = I;
  shape[ndim-1] = J;

  // FIND COMMON (BROADCASTED) SHAPE
  for( let arr of [Q,R,y] )
    for( let i=ndim-2, j=arr.ndim-2; i-- > 0 && j-- > 0; )
      if( 1 === shape[i] )
        shape[i] = arr.shape[j];
      else if( shape[i] != arr.shape[j] && arr.shape[j] != 1 )
        throw new Error('rrqr_lstsq(Q,R,P,y): Q,R,P,y not broadcast-compatible.');

  for( let i=ndim-2, j=P.ndim-1; i-- > 0 && j-- > 0; )
    if( 1 === shape[i] )
      shape[i] = P.shape[j];
    else if( shape[i] != P.shape[j] && P.shape[j] != 1 )
      throw new Error('rrqr_lstsq(Q,R,P,y): Q,R,P,y not broadcast-compatible.');

  // GENERATE RESULT DATA
  const
    DTypeArray = ARRAY_TYPES[ [Q,R,y].every( a => a.dtype==='float32' ) ? 'float32' : 'float64' ],
    tmp_rank = new DTypeArray( Math.min(M,I) ),
    tmp_perm = new Int32Array(I),
    x_dat = new DTypeArray( shape.reduce((a,b) => a*b, 1) ),
    Q_dat = Q.data,
    R_dat = R.data,
    P_dat = P.data,
    y_dat = y.data;
  let
    Q_off = 0, Q_stride = 1,
    R_off = 0, R_stride = 1,
    P_off = 0, P_stride = 1,
    y_off = 0, y_stride = 1,
    x_off = 0;

  function solv(d) {
    if( d === ndim-2 ) {
      Q_stride = N*M;
      R_stride = M*I;
      P_stride =   I;
      y_stride = N*J;

      const R = _rrqr_rank(M,I, R_dat,R_off, tmp_rank)

      // Q.T @ y
      for( let k=0; k < N; k++ )
      for( let i=0; i < R; i++ )
      for( let j=0; j < J; j++ )
        x_dat[x_off+i*J+j] += Q_dat[Q_off+k*M+i] * y_dat[y_off+k*J+j]


      // BACKWARD SUBSTITUTION
      for( let i=R; i-- > 0; )
      for( let j=J; j-- > 0; ) {
        for( let k=R; --k > i; )
          x_dat[x_off+i*J+j] -= R_dat[R_off+I*i+k] * x_dat[x_off+k*J+j]
        x_dat[x_off+i*J+j] /= R_dat[R_off+I*i+i]
      }


      // APPLY P TO X (PERMUTE ROWS)
      // https://www.geeksforgeeks.org/reorder-a-array-according-to-given-indexes/
      for( let i=I; i-- > 0; )
        tmp_perm[i] = P_dat[P_off + i]

      for( let i=I; i-- > 0; )
      {
        let k
        while( (k = tmp_perm[i]) !== i )
        {
          if( tmp_perm[k] === k )
            throw new Error("rrqr_lstsq(Q,R,P,y): Invalid indices in P.")
          tmp_perm[i] = tmp_perm[k]
          tmp_perm[k] = k

          for( let j=J; j-- > 0; )
          {
            const x_ij = x_dat[x_off + J*i+j]
                         x_dat[x_off + J*i+j] = x_dat[x_off + J*k+j]
                                                x_dat[x_off + J*k+j] = x_ij
          }
        }
      }


      Q_off += Q_stride;
      R_off += R_stride;
      P_off += P_stride;
      y_off += y_stride;
      x_off += I*J;

      return;
    }
    for( let l=shape[d]; ; l-- ) {
      solv(d+1);
      if( l == 1 ) break;
      if( ! (Q.shape[ d - ndim   + Q.ndim ] > 1) ) Q_off -= Q_stride;
      if( ! (R.shape[ d - ndim   + R.ndim ] > 1) ) R_off -= R_stride;
      if( ! (P.shape[ d - ndim+1 + P.ndim ] > 1) ) P_off -= P_stride;
      if( ! (y.shape[ d - ndim   + y.ndim ] > 1) ) y_off -= y_stride;
    }
    Q_stride *= Q.shape[ d - ndim   + Q.ndim ] || 1;
    R_stride *= R.shape[ d - ndim   + R.ndim ] || 1;
    P_stride *= P.shape[ d - ndim+1 + P.ndim ] || 1;
    y_stride *= y.shape[ d - ndim   + y.ndim ] || 1;
  }
  solv(0);

  return new NDArray(shape,x_dat);

  throw new Error('Not yet implemented!')
}