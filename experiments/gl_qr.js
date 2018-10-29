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

/** This script contains the 2nd version of a proof-of-concept
  * implementation of the QR Decomposition in WebGL2.
  * 
  * Version 2 calculates the square roots of the diagonal only 3
  * times per diagonal element.
  */

const gl_cholesky/*: nd.Array => nd.Array*/ = function() {

  const VERT_SHADER_INDENT = `\
    precision highp float;
  
    // INPUTS
    attribute vec2 pos;

    uniform float NaN,
                  size,  // <- the number of rows/columns in the matrix
                  offset;// <- the index before the column that is currently finalized by the CholeskyDecomposition

    uniform sampler2D matrix;
  
    // OUTPUTS
    varying highp vec2 index;
    varying highp float m_kk; // <- computing diag. elem. here to avoid repeated sqrt-computation
  
    // SHADER
    void main() {
      // 1
      //  |\
      //  | \
      //  |__\
      // 2    3
      if( 1.0 == cornerIndex ) { index = vec2(-0.5+offset, -1.0+offset); }
      if( 2.0 == cornerIndex ) { index = vec2(-0.5+offset,  0.5+ size ); }
      if( 3.0 == cornerIndex ) { index = vec2( 1.0+  size,  0.5+ size ); }
      gl_Position = vec4( (index+0.5)/size*2.0 - 1.0, 0.0, 1.0 );

      m_kk = texture2D( matrix, vec2(offset + 1.5)/size ).x;
      m_kk = sqrt(m_kk);
    }
  `;
  
  const FRAG_SHADER_INDENT = `\
    precision highp float;
  
    // INPUTS
    varying highp vec2  index;
    varying highp float m_kk;

    uniform float size,
                  offset;

    uniform sampler2D matrix;

    float m( float i, float j )
    {
      return texture2D( matrix, vec2(j,i)/size ).x;
    }
    
    void main() {
      float i = floor(index.y+0.5),
            j = floor(index.x+0.5),
            k = floor(offset +1.5),
         m_ik =       m(i,k) / m_kk,
         m_jk =       m(j,k) / m_kk,
         m_ij =       m(i,j);

           if( j <  k )  gl_FragColor = vec4(m_ij); // <- copy column left to the currently finalized column
      else if( j == k ) {
           if( i == k )  gl_FragColor = vec4(m_kk); // <- diagonal element
           else          gl_FragColor = vec4(m_ik); // <- elements below diagonal element
      }    else          gl_FragColor = vec4(m_ij - m_ik*m_jk); // <- remaining elements
    }
  `;

   //
  // INIT
 //
  const canvas = document.createElement('canvas');
  canvas.width  = 1;
  canvas.height = 1;
  const gl = canvas.getContext("webgl2",{
    antialias: false,
    stencil: false,
    alpha: false
  });
  console.log( 'GLSL Version:', gl.getParameter(gl.SHADING_LANGUAGE_VERSION) );

  if( ! gl.getExtension("EXT_color_buffer_float") )
    throw new Error('HDR rendering not supported.');

  const mkShader = (code,type) => {
    const shader = gl.createShader(type);
    gl.shaderSource(shader, code);
    gl.compileShader(shader);

    const log = gl.getShaderInfoLog(shader);
    console.log(log);

    const compiled = gl.getShaderParameter(shader, gl.COMPILE_STATUS);

    if(compiled) return shader;

    gl.deleteShader(shader);
    throw new Error('Could not compile shader.');
  };

  const mkProgram = (vertShader, fragShader) => {
    vertShader = mkShader(vertShader, gl.  VERTEX_SHADER);
    fragShader = mkShader(fragShader, gl.FRAGMENT_SHADER);

    const program = gl.createProgram();
    gl.attachShader(program, vertShader);
    gl.attachShader(program, fragShader);
    gl.linkProgram(program);
    gl.useProgram(program);

    const linked = gl.getProgramParameter(program, gl.LINK_STATUS);

    const log = gl.getProgramInfoLog(program);
    console.log(log);

    if(linked) return program;

    gl.deleteProgram(program);
    throw new Error('Could not link program.');
  };

  const cornerLoc = gl. getAttribLocation(program, 'cornerIndex'),
        offsetLoc = gl.getUniformLocation(program, 'offset'),
          sizeLoc = gl.getUniformLocation(program, 'size'  ),
           nanLoc = gl.getUniformLocation(program, 'NaN'  );

  const cornerBuf = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, cornerBuf);
  gl.bufferData(gl.ARRAY_BUFFER, Float32Array.of(1,2,3), gl.STATIC_DRAW);
  gl.enableVertexAttribArray(cornerLoc);
  gl.vertexAttribPointer(cornerLoc, 1, gl.FLOAT, false, 0, 0);

  let [matrix1Tex,indent1Tex,colH1Tex,
       matrix2Tex,indent2Tex,colH2Tex] = function*(){
    for( let i=0; i < 6; i++ ) {
      const text = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      yield tex;
    }
  }();

  const frameBuf = gl.createFramebuffer();
  gl.bindFramebuffer(gl.FRAMEBUFFER, frameBuf);
  gl.uniform1f(nanLoc, NaN);

  return S => {
    if( S.ndim != 2 ) throw new Error('S is not a matrix.');
    const [M,N] = S.shape.slice(-2);
    if( M != N ) throw new Error('S must be quadratic.');
    if( S.dtype != 'float32' ) throw new Error("S.dtype must be 'float32'.");

     //
    // UPLOAD
   //
    console.time('upload');

    gl.uniform1f(sizeLoc,N);

    gl.bindTexture(gl.TEXTURE_2D, matrix1Tex);
    gl.texImage2D(
      /*target=*/gl.TEXTURE_2D,
      /*levelOfDetail=*/0,
      /*internalFormat=*/gl.R32F,
      /*width,height=*/N,N,
      /*border=*/0,
      /*format=*/gl.RED,
      /*type=*/gl.FLOAT,
      /*srcData=*/S.data
    );
    gl.bindTexture(gl.TEXTURE_2D, matrix2Tex);
    gl.texImage2D(
      /*target=*/gl.TEXTURE_2D,
      /*levelOfDetail=*/0,
      /*internalFormat=*/gl.R32F,
      /*width,height=*/N,N,
      /*border=*/0,
      /*format=*/gl.RED,
      /*type=*/gl.FLOAT,
      /*srcData=*/null
    );
    gl.activeTexture(gl.TEXTURE0 + 0);
    gl.viewport(0,0,N,N);
    gl.drawBuffers([gl.COLOR_ATTACHMENT0]);

    gl.finish();
    console.timeEnd('upload');

     //
    // COMPUTE
   //
    console.time('computation');

    for( let off = -1; off < N-1; off++ )
    {
      // SET OFFSET
      gl.uniform1f(offsetLoc,off);

      // SET WRITE TO MATRIX 2
      gl.framebufferTexture2D(
        /*target=*/gl.DRAW_FRAMEBUFFER,
        /*attachment=*/gl.COLOR_ATTACHMENT0,
        /*texTarget=*/gl.TEXTURE_2D,
        /*texture=*/matrix2Tex,
        /*levelOfDetail=*/0
      );

      // SET READ FROM MATRIX 1
      gl.bindTexture(gl.TEXTURE_2D, matrix1Tex);

      // COMPUTE
      gl.drawArrays(gl.TRIANGLES, 0,3);

      [matrix1Tex,matrix2Tex] = [matrix2Tex,matrix1Tex];
    }

    gl.finish();
    console.timeEnd('computation');

     //
    // DOWNLOAD
   //
    let matrixOut = new Float32Array(4*N*N);
    console.time('download')
    gl.readBuffer(gl.COLOR_ATTACHMENT0);
    gl.readPixels(
      /*x,y=*/0,0,
      /*w,h=*/N,N,
      /*format=*/gl.RGBA,
      /*type=*/gl.FLOAT,
      /*writeTo=*/matrixOut
    );
    console.timeEnd('download')
    matrixOut = matrixOut.filter( (_,i) => i%4 == 0 );

    return new nd.Array(S.shape,matrixOut)
  };
}();

function main()
{
  const test = ( /*int*/run ) => () =>
  {
    if( run > 0 )
    {
      console.log('\nRUN:',run);
      let
        randInt = (from,until) => Math.floor(Math.random()*(until-from)) + from,
        shape = 512;
      shape = [shape,shape]; 
      const L = nd.tabulate(shape,'float64',(...indices) => {
        const [i,j] = indices.slice(-2);
        if( i==j ) return Math.random()*1.0 + 0.5;
        if( i< j ) return 0;
        return Math.random()*0.2 - 0.1;
      });
      let LLT = nd.la.matmul2(L,L.T);
      LLT = nd.Array.from(LLT,'float32')

      const label = `N=${shape[0].toString().padStart(4) }`;
      console.time(label);
      let l = gl_cholesky(LLT);
      console.timeEnd(label); 

      l = nd.la.tril(l);

      const is_close = (/*float*/x,/*float*/y) => {
        const atol = 1e-4,
              rtol = 1e-4,
               tol = atol + rtol * Math.max(
                Math.abs(x),
                Math.abs(y)
              );
        return Math.abs(x-y) <= tol;
      }

      nd.Array.from([L,l], 'float32', (x,y,...indices) => {
        if( ! is_close(x,y) ) {
          let msg = '{\n'+L+'\n} expected but {\n'+l+'\n} encountered.\n'+x+' != '+y+' at index ['+indices+']';
          throw new Error(msg);
        }
      });
      setTimeout( test(run-1) );
    }
  }
  setTimeout( test(1024) );
}

main();
