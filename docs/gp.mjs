// GP inference library for BOxCrete interactive demo.
// Implements Matérn 5/2 + RBF additive kernel, input transforms,
// and exact GP posterior (mean + variance).
// Optionally uses WASM SIMD for accelerated variance computation.

// --- WASM BLAS state (initialized asynchronously) ---
let _wasm = null;
let _wasmN = 0;     // matrix size stored in WASM
let _wasmD = 0;     // input dimensionality
// Persistent WASM memory pointers (allocated once, reused every frame)
let _ptrL = 0;      // L matrix (n×n, F64)
let _ptrX = 0;      // X_train (n×d, F64) — stored for reference
let _ptrNorms = 0;  // norms output buffer (max_nrhs, F64)
const _MAX_NRHS = 256;

/**
 * Initialize WASM BLAS for accelerated GP inference.
 * Stores L, X_train, alpha, and lengthscales permanently in WASM memory.
 * Call after initStrengthModel(). Falls back gracefully if unavailable.
 * @param {object} params - Model params
 * @returns {Promise<boolean>} true if WASM loaded
 */
export async function initWASM(params) {
  try {
    const module = await import("./blas_f64.js");
    _wasm = await module.default();
    const n = params.n_train;
    const d = params.d_in;
    _wasmN = n;
    _wasmD = d;

    // Allocate persistent F64 buffers
    _ptrL = _wasm._malloc(n * n * 8);   // L matrix (F64)
    _ptrNorms = _wasm._malloc(_MAX_NRHS * 8); // norms output (F64)

    // Copy L into WASM memory (F64)
    const h64 = new Float64Array(_wasm.HEAPF64.buffer);
    const L = params.L_flat;
    for (let i = 0; i < n * n; i++) h64[_ptrL / 8 + i] = L[i];

    return true;
  } catch (e) {
    console.warn("WASM BLAS not available:", e.message);
    return false;
  }
}

/** @returns {boolean} Whether WASM acceleration is active */
export function isWASMReady() { return _wasm !== null; }

/**
 * Matérn 5/2 kernel with ARD lengthscales.
 * k(x1, x2) = outputscale * (1 + √5r + 5r²/3) * exp(-√5r)
 * where r = sqrt(Σᵢ ((x1ᵢ - x2ᵢ)/lᵢ)²)
 */
function matern52(x1, x2, lengthscales, outputscale) {
  let r2 = 0;
  for (let i = 0; i < x1.length; i++) {
    const d = (x1[i] - x2[i]) / lengthscales[i];
    r2 += d * d;
  }
  const r = Math.sqrt(r2);
  const sqrt5r = Math.sqrt(5) * r;
  return outputscale * (1 + sqrt5r + (5 * r2) / 3) * Math.exp(-sqrt5r);
}

/**
 * RBF (squared exponential) kernel on a single dimension.
 * k(t1, t2) = outputscale * exp(-0.5 * ((t1-t2)/l)²)
 */
function rbf(t1, t2, lengthscale, outputscale) {
  const d = (t1 - t2) / lengthscale;
  return outputscale * Math.exp(-0.5 * d * d);
}

/**
 * Combined additive kernel: ScaleKernel(Matérn5/2) + ScaleKernel(RBF on time).
 */
function kernel(x1, x2, params) {
  const timeDim = params.time_dim;
  const kMatern = matern52(x1, x2, params.matern_lengthscales, params.matern_outputscale);
  const kRbf = rbf(x1[timeDim], x2[timeDim], params.rbf_lengthscale, params.rbf_outputscale);
  return kMatern + kRbf;
}

/**
 * Apply input transforms: time+1 → log10 → normalize to [0,1].
 * Modifies input in-place and returns it.
 */
function transformInput(x, params) {
  const out = new Array(x.length);
  const timeDim = params.time_dim;

  // Copy all dims
  for (let i = 0; i < x.length; i++) {
    out[i] = x[i];
  }

  // Time transform: log10(time + 1)
  out[timeDim] = Math.log10(out[timeDim] + 1);

  // Normalize all dims to [0, 1]
  for (let i = 0; i < out.length; i++) {
    const lo = params.normalize_lower[i];
    const hi = params.normalize_upper[i];
    out[i] = (out[i] - lo) / (hi - lo);
  }

  return out;
}

/**
 * Compute kernel vector k(x*, X_train) for a single test point.
 */
function kernelVector(xStar, XTrain, params) {
  const n = XTrain.length;
  const kVec = new Array(n);
  for (let i = 0; i < n; i++) {
    kVec[i] = kernel(xStar, XTrain[i], params);
  }
  return kVec;
}

/**
 * Cholesky decomposition of a symmetric positive-definite matrix.
 * Returns lower triangular L such that A = L L^T.
 * @param {number[][]} A - Symmetric positive-definite matrix (n×n).
 * @returns {number[][]} Lower triangular factor L.
 */
function cholesky(A) {
  const n = A.length;
  const L = Array.from({ length: n }, () => new Array(n).fill(0));
  for (let i = 0; i < n; i++) {
    for (let j = 0; j <= i; j++) {
      let s = A[i][j];
      for (let k = 0; k < j; k++) {
        s -= L[i][k] * L[j][k];
      }
      L[i][j] = i === j ? Math.sqrt(s) : s / L[j][j];
    }
  }
  return L;
}

/**
 * Initialize a strength model: compute the kernel matrix, Cholesky factor,
 * L⁻¹ (for fast variance), and alpha vector from the exported parameters.
 * Call once on page load.
 * Mutates params by adding `L_inv_flat`, `alpha_f64`, and `X_train_flat` fields.
 * @param {object} params - Raw parameters from strength.json.
 */
export function initStrengthModel(params) {
  const n = params.n_train;
  const d = params.d_in;
  const X = params.X_train;

  // Convert X_train to flat Float64Array for cache-friendly access
  const X_flat = new Float64Array(n * d);
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < d; j++) X_flat[i * d + j] = X[i][j];
  }
  params.X_train_flat = X_flat;

  // Build kernel matrix K + noise*I (heteroscedastic: learned for real, fixed for pseudo)
  const K = new Float64Array(n * n);
  const nReal = params.n_real || n;
  const pseudoNoise = params.pseudo_noise || params.noise_variance;
  for (let i = 0; i < n; i++) {
    for (let j = i; j < n; j++) {
      const k = kernel(X[i], X[j], params);
      K[i * n + j] = k;
      K[j * n + i] = k;
    }
    K[i * n + i] += i < nReal ? params.noise_variance : pseudoNoise;
  }

  // Cholesky decomposition (flat storage)
  const L = new Float64Array(n * n);
  for (let i = 0; i < n; i++) {
    for (let j = 0; j <= i; j++) {
      let s = K[i * n + j];
      for (let k = 0; k < j; k++) s -= L[i * n + k] * L[j * n + k];
      L[i * n + j] = i === j ? Math.sqrt(s) : s / L[j * n + j];
    }
  }

  params.L_flat = L; // flat Float64Array for forward solve in predictStrengthCurve
  params.n = n;

  // Solve for alpha using the flat L
  // Forward solve: L z = (Y - prior_mean)
  const rhs = new Float64Array(n);
  for (let i = 0; i < n; i++) rhs[i] = params.Y_train[i] - params.prior_mean;
  const z = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    let s = rhs[i];
    for (let j = 0; j < i; j++) s -= L[i * n + j] * z[j];
    z[i] = s / L[i * n + i];
  }

  // Backward solve: L^T alpha = z
  const alpha = new Float64Array(n);
  for (let i = n - 1; i >= 0; i--) {
    let s = z[i];
    for (let j = i + 1; j < n; j++) s -= L[j * n + i] * alpha[j];
    alpha[i] = s / L[i * n + i];
  }
  params.alpha_f64 = alpha;
  // Keep backward-compatible alpha for predictStrength (single point)
  params.alpha = Array.from(alpha);
  // Keep L_factor for backward compat with test
  params.L_factor = Array.from({ length: n }, (_, i) =>
    Array.from({ length: n }, (_, j) => L[i * n + j])
  );
}

/**
 * Solve L z = b for z, where L is lower triangular (forward substitution).
 */
function solveTriangularLower(L, b) {
  const n = b.length;
  const z = new Array(n);
  for (let i = 0; i < n; i++) {
    let s = b[i];
    for (let j = 0; j < i; j++) {
      s -= L[i][j] * z[j];
    }
    z[i] = s / L[i][i];
  }
  return z;
}

/**
 * Predict GP posterior mean at a single (already-transformed) test point.
 * μ(x*) = prior_mean + k* · α, un-standardized to original scale.
 */
function predictMeanTransformed(xStar, params) {
  const kVec = kernelVector(xStar, params.X_train, params);
  let mean = params.prior_mean;
  for (let i = 0; i < kVec.length; i++) {
    mean += kVec[i] * params.alpha[i];
  }
  // Un-standardize
  return mean * params.y_std + params.y_mean;
}

/**
 * Predict GP posterior variance at a single (already-transformed) test point.
 * σ²(x*) = k(x*,x*) - k*ᵀ K⁻¹ k* = k(x*,x*) - ||L⁻¹k*||²
 * Un-standardized to original scale.
 */
function predictVarianceTransformed(xStar, params) {
  const kVec = kernelVector(xStar, params.X_train, params);
  const kSelf = kernel(xStar, xStar, params);

  // Solve L v = k* (forward substitution)
  const v = solveTriangularLower(params.L_factor, kVec);

  // ||v||² = k*ᵀ K⁻¹ k*
  let vNormSq = 0;
  for (let i = 0; i < v.length; i++) {
    vNormSq += v[i] * v[i];
  }

  const varStd = Math.max(0, kSelf - vNormSq);
  // Un-standardize: variance scales by y_std²
  return varStd * params.y_std * params.y_std;
}

/**
 * Predict strength (mean and variance) for a raw composition + time.
 * @param {number[]} composition - Raw composition values (without time).
 * @param {number} time - Curing time in days.
 * @param {object} params - Model parameters from strength.json.
 * @returns {{mean: number, variance: number}}
 */
export function predictStrength(composition, time, params) {
  // Build full input vector (composition + time)
  const x = [...composition, time];
  // Apply input transforms
  const xT = transformInput(x, params);

  // Fused mean + variance: compute kVec once
  const kVec = kernelVector(xT, params.X_train, params);

  let mean = params.prior_mean;
  for (let i = 0; i < kVec.length; i++) {
    mean += kVec[i] * params.alpha[i];
  }

  const kSelf = kernel(xT, xT, params);
  const v = solveTriangularLower(params.L_factor, kVec);
  let vNormSq = 0;
  for (let i = 0; i < v.length; i++) vNormSq += v[i] * v[i];
  const varStd = Math.max(0, kSelf - vNormSq);

  return {
    mean: mean * params.y_std + params.y_mean,
    variance: varStd * params.y_std * params.y_std,
  };
}

/**
 * Predict strength curve over a time range (optimized batch version).
 * Uses pre-computed L⁻¹ (flat Float64Array) for parallelizable variance,
 * flat X_train for cache locality, and typed alpha for fast dot products.
 * @param {number[]} composition - Raw composition values (without time).
 * @param {number[]} times - Array of time points.
 * @param {object} params - Model parameters from strength.json.
 * @returns {{means: number[], variances: number[]}}
 */
export function predictStrengthCurve(composition, times, params) {
  const timeDim = params.time_dim;
  const n = params.n_train;
  const d = params.d_in;

  // Pre-transform composition (everything except time)
  const xBase = new Float64Array(d);
  for (let i = 0; i < composition.length; i++) {
    if (i === timeDim) continue;
    const lo = params.normalize_lower[i];
    const hi = params.normalize_upper[i];
    xBase[i] = (composition[i] - lo) / (hi - lo);
  }

  const timeLo = params.normalize_lower[timeDim];
  const timeHi = params.normalize_upper[timeDim];
  const X_flat = params.X_train_flat; // Float64Array[n * d]
  const alpha = params.alpha_f64;     // Float64Array[n]
  const L = params.L_flat;            // Float64Array[n * n] (lower triangular)
  const yStd = params.y_std;
  const yMean = params.y_mean;
  const priorMean = params.prior_mean;
  const mLS = params.matern_lengthscales;
  const mOS = params.matern_outputscale;
  const rbfLS = params.rbf_lengthscale;
  const rbfOS = params.rbf_outputscale;
  const kSelf = mOS + rbfOS; // k(x,x) for any x

  const nTimes = times.length;
  const means = new Float64Array(nTimes);
  const variances = new Float64Array(nTimes);

  // Build all kernel vectors and compute means
  // If WASM available, use fully-accelerated path (kernels + solve in WASM)
  const useWasm = _wasm !== null && _wasmN === n;

  if (useWasm) {
    // --- ALL-F64 WASM SIMD PATH ---
    // Compute kernel vectors in JS F64 (precision), solve with WASM F64 dtrsm (speed)
    const ptrK64 = _wasm._malloc(n * nTimes * 8);
    const h64v = new Float64Array(_wasm.HEAPF64.buffer);

    for (let ti = 0; ti < nTimes; ti++) {
      const tTransformed = (Math.log10(times[ti] + 1) - timeLo) / (timeHi - timeLo);
      xBase[timeDim] = tTransformed;
      const colOff = ptrK64 / 8 + ti * n;
      let mean = priorMean;
      for (let i = 0; i < n; i++) {
        const rowOff = i * d;
        let r2 = 0;
        for (let dim = 0; dim < d; dim++) {
          const dd = (xBase[dim] - X_flat[rowOff + dim]) / mLS[dim];
          r2 += dd * dd;
        }
        const r = Math.sqrt(r2);
        const sqrt5r = 2.23606797749979 * r;
        const kM = mOS * (1 + sqrt5r + (5 * r2) / 3) * Math.exp(-sqrt5r);
        const dt = (tTransformed - X_flat[rowOff + timeDim]) / rbfLS;
        const kVal = kM + rbfOS * Math.exp(-0.5 * dt * dt);
        h64v[colOff + i] = kVal;
        mean += kVal * alpha[i];
      }
      means[ti] = mean * yStd + yMean;
    }

    // Variance: WASM F64 SIMD triangular solve + column norms
    _wasm._dtrsm_lower(n, nTimes, _ptrL, ptrK64);
    _wasm._col_norms_sq_f64(n, nTimes, ptrK64, _ptrNorms);

    const normsF64 = new Float64Array(_wasm.HEAPF64.buffer).subarray(_ptrNorms / 8, _ptrNorms / 8 + nTimes);
    for (let ti = 0; ti < nTimes; ti++) {
      variances[ti] = Math.max(0, kSelf - normsF64[ti]) * yStd * yStd;
    }
    _wasm._free(ptrK64);
  } else {
    // --- JS FALLBACK PATH ---
    const kVec = new Float64Array(n);
    const v = new Float64Array(n);

    for (let ti = 0; ti < nTimes; ti++) {
      const tTransformed = (Math.log10(times[ti] + 1) - timeLo) / (timeHi - timeLo);
      xBase[timeDim] = tTransformed;

      let mean = priorMean;
      for (let i = 0; i < n; i++) {
        const rowOff = i * d;
        let r2 = 0;
        for (let dim = 0; dim < d; dim++) {
          const dd = (xBase[dim] - X_flat[rowOff + dim]) / mLS[dim];
          r2 += dd * dd;
        }
        const r = Math.sqrt(r2);
        const sqrt5r = 2.23606797749979 * r;
        const kM = mOS * (1 + sqrt5r + (5 * r2) / 3) * Math.exp(-sqrt5r);
        const dt = (tTransformed - X_flat[rowOff + timeDim]) / rbfLS;
        const kVal = kM + rbfOS * Math.exp(-0.5 * dt * dt);
        kVec[i] = kVal;
        mean += kVal * alpha[i];
      }
      means[ti] = mean * yStd + yMean;

      // Variance via forward solve
      let vNormSq = 0;
      for (let i = 0; i < n; i++) {
        let s = kVec[i];
        const rowOff = i * n;
        for (let j = 0; j < i; j++) s -= L[rowOff + j] * v[j];
        v[i] = s / L[rowOff + i];
      }
      for (let i = 0; i < n; i++) vNormSq += v[i] * v[i];
      variances[ti] = Math.max(0, kSelf - vNormSq) * yStd * yStd;
    }
  }

  return { means, variances };
}

/**
 * Predict strength curve MEAN ONLY (no variance) — much faster for previews.
 * Skips the expensive Cholesky solve; only computes k_star^T @ alpha.
 */
export function predictStrengthMeanOnly(composition, times, params) {
  const timeDim = params.time_dim;
  const n = params.n_train;
  const d = params.d_in;

  const xBase = new Float64Array(d);
  for (let i = 0; i < composition.length; i++) {
    if (i === timeDim) continue;
    const lo = params.normalize_lower[i];
    const hi = params.normalize_upper[i];
    xBase[i] = (composition[i] - lo) / (hi - lo);
  }

  const timeLo = params.normalize_lower[timeDim];
  const timeHi = params.normalize_upper[timeDim];
  const X_flat = params.X_train_flat;
  const alpha = params.alpha_f64;
  const yStd = params.y_std;
  const yMean = params.y_mean;
  const priorMean = params.prior_mean;
  const mLS = params.matern_lengthscales;
  const mOS = params.matern_outputscale;
  const rbfLS = params.rbf_lengthscale;
  const rbfOS = params.rbf_outputscale;

  const nTimes = times.length;
  const means = new Float64Array(nTimes);

  for (let ti = 0; ti < nTimes; ti++) {
    const tTransformed = (Math.log10(times[ti] + 1) - timeLo) / (timeHi - timeLo);
    xBase[timeDim] = tTransformed;
    let mean = priorMean;
    for (let i = 0; i < n; i++) {
      const rowOff = i * d;
      let r2 = 0;
      for (let dim = 0; dim < d; dim++) {
        const dd = (xBase[dim] - X_flat[rowOff + dim]) / mLS[dim];
        r2 += dd * dd;
      }
      const r = Math.sqrt(r2);
      const sqrt5r = 2.23606797749979 * r;
      const kM = mOS * (1 + sqrt5r + (5 * r2) / 3) * Math.exp(-sqrt5r);
      const dt = (tTransformed - X_flat[rowOff + timeDim]) / rbfLS;
      const kVal = kM + rbfOS * Math.exp(-0.5 * dt * dt);
      mean += kVal * alpha[i];
    }
    means[ti] = mean * yStd + yMean;
  }
  return means;
}

/**
 * Predict GWP using the linear model.
 * mean = Σᵢ xᵢ * cᵢ (negated, as model stores -GWP)
 * variance = Σᵢ xᵢ² * σᵢ²
 * @param {number[]} composition - Raw composition values (without time).
 * @param {object} gwpParams - Model parameters from gwp.json.
 * @param {number} [materialSource=0] - Material source class index.
 * @returns {{mean: number, variance: number}}
 */
export function predictGWP(composition, gwpParams, materialSource = 0) {
  const cls = String(materialSource);
  const coeffs = gwpParams.coefficients[cls];
  const means = coeffs.means;
  const variances = coeffs.variances;

  let mean = 0;
  let variance = 0;

  // If class-indexed, skip the class_dim column in dot product
  const classDim = gwpParams.class_dim;
  let ci = 0;
  for (let i = 0; i < composition.length; i++) {
    if (i === classDim) continue;
    mean += composition[i] * means[ci];
    variance += composition[i] * composition[i] * variances[ci];
    ci++;
  }

  return { mean, variance };
}

/**
 * Predict Cost using the linear model.
 * mean = Σᵢ xᵢ * cᵢ (negated, as model stores -Cost)
 * variance = Σᵢ xᵢ² * σᵢ²
 * @param {number[]} composition - Raw composition values (without time).
 * @param {object} costParams - Model parameters (coefficients.means/variances).
 * @returns {{mean: number, variance: number}}
 */
export function predictCost(composition, costParams) {
  const means = costParams.coefficients.means;
  const variances = costParams.coefficients.variances;

  let mean = 0;
  let variance = 0;

  for (let i = 0; i < means.length; i++) {
    mean += composition[i] * means[i];
    variance += composition[i] * composition[i] * variances[i];
  }

  return { mean, variance };
}

// Export kernel functions for testing
export { matern52, rbf, kernel, transformInput, solveTriangularLower, cholesky };
