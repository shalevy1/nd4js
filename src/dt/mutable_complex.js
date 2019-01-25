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


export class MutableComplex
{
  constructor( re, im ) {
    this.re = re*1.0;
    this.im = im*1.0;
  }

  abs() {
    return Math.hypot(this.re, this.im);
  }

  ['/=']( re, im ) {
    if( im === 0 ) {
      this.re /= re;
      this.im /= re;
    }
    else {
      const this_re = this.re;
      if( Math.abs(re) >= Math.abs(im) )
      { const R = im / re;
        this.re = (this_re + this.im*R) / (re + im*R);
        this.im = (this.im - this_re*R) / (re + im*R);
      } else {
        const R = re / im;
        this.re = (this_re*R + this.im) / (re*R + im);
        this.im = (this.im*R - this_re) / (re*R + im);        
      }
    }
  }

  ['= c0*c1']( re0,im0, re1,im1 )
  {
    this.re = re0*re1 - im0*im1;
    this.im = re0*im1 + im0*re1;
  }

  ['-= c0*c1']( re0,im0, re1,im1 )
  {
    this.re -= re0*re1 - im0*im1;
    this.im -= re0*im1 + im0*re1;
  }
//
//  ['/= c0']( re, im )
//  {
//    throw new Error('Not yet implemented!');
//  }
//  add( re, im ) {
//    if( null == re ) re = 0.0;
//    if( null == im ) im = 0.0;
//    if( re.re != null ||
//        re.im != null ) {
//      im = re.im || 0;
//      re = re.re || 0;
//    }
//    return new Complex(
//      this.re + re,
//      this.im + im
//    );
//  }
//
//  sub( re, im ) {
//    if( null == re ) re = 0.0;
//    if( null == im ) im = 0.0;
//    if( re.re != null ||
//        re.im != null ) {
//      im = re.im || 0;
//      re = re.re || 0;
//    }
//    return new Complex(
//      this.re - re,
//      this.im - im
//    );
//  }
//
//  mul( re, im ) {
//    if( null == re ) re = 0.0;
//    if( null == im ) im = 0.0;
//    if( re.re != null ||
//        re.im != null ) {
//      im = re.im || 0;
//      re = re.re || 0;
//    }
//    return new Complex(
//      this.re*re - this.im*im,
//      this.re*im + this.im*re
//    );
//  }
//
//  div( re, im ) {
//    if( null == re ) re = 0.0;
//    if( null == im ) im = 0.0;
//    if( re.re != null ||
//        re.im != null ) {
//      im = re.im || 0;
//      re = re.re || 0;
//    }
//    if( im == 0 ) return new Complex(this.re/re, this.im/re);
//
////    return new Complex(
////      (this.re*re + this.im*im) / (re*re + im*im),
////      (this.im*re - this.re*im) / (re*re + im*im)
////    );
//
//    if( Math.abs(re) >= Math.abs(im) )
//    {
//      const R = im / re;
//      return new Complex(
//        (this.re + this.im*R) / (re + im*R),
//        (this.im - this.re*R) / (re + im*R)
//      );
//    } else {
//      const R = re / im;
//      return new Complex(
//        (this.re*R + this.im) / (re*R + im),
//        (this.im*R - this.re) / (re*R + im)
//      );        
//    }
//  }
//
//  equals( re, im ) {
//    if( null == re ) re = 0.0;
//    if( null == im ) im = 0.0;
//    if( re.re != null ||
//        re.im != null ) {
//      im = re.im || 0;
//      re = re.re || 0;
//    }
//    return this.re == re
//        && this.im == im;
//  }
//
//  abs() {
//    return Math.hypot(this.re, this.im);
//  }
//
//  arg() {
//    return Math.atan2(this.im, this.re);
//  }
//
//  conj() {
//    return new Complex(this.re, -this.im );
//  }
//
//  toFixed(digits) {
//    return new Complex(
//      this.re.toFixed(digits),
//      this.im.toFixed(digits)
//    );
//  }
//
//  sqrt() {
//    // https://en.wikipedia.org/wiki/Square_root#Algebraic_formula
//    const abs = this.abs();
//    return new Complex(
//      math.sqrt( math.mul( math.add(abs,this.re), 0.5 ) ),
//      math.sqrt( math.mul( math.sub(abs,this.re), 0.5 ) )
//    );
//  }

  // https://nodejs.org/api/util.html#util_util_inspect_custom
  [Symbol.for('nodejs.util.inspect.custom')]() { return this.toString(); }

  toString() {
    if( this.im == 0 ) return this.re.toString();
    if( this.re == 0 ) return `${this.im}j`;
    if( this.im <  0 ) return `${this.re} - ${-this.im}j`;
    return `${this.re} + ${this.im}j`;
  }
}
