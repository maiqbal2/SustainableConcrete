#!/usr/bin/env python3
# Copyright (c) Meta Platforms, Inc. and affiliates.
#
# This source code is licensed under the MIT license found in the
# LICENSE file in the root directory of this source tree.

"""Export fitted GP model parameters to JSON for the JavaScript interactive demo.

Usage:
    python scripts/export_model.py

Outputs:
    docs/model/strength.json    - GP parameters for strength prediction
    docs/model/gwp.json         - Linear model coefficients for GWP
    docs/model/compositions.json - Training compositions + predictions for scatter plot
    docs/model/test_vectors.json - Reference predictions for CI sync testing
"""

import json
import os
import sys

import torch
from linear_operator.utils.cholesky import psd_safe_cholesky

# Add repo root to path
REPO_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, REPO_DIR)

from boxcrete.models import SustainableConcreteModel
from boxcrete.utils import load_concrete_strength

OUTPUT_DIR = os.path.join(REPO_DIR, "docs", "model")
STRENGTH_DAYS = [1, 28]


def to_list(t):
    """Convert tensor to nested Python list."""
    return t.detach().cpu().tolist()


def export_strength_model(model, data):
    """Export strength GP parameters for JS inference."""
    gp = model.strength_model

    # Extract kernel hyperparameters from the additive kernel
    # kernel = ScaleKernel(MaternKernel) + ScaleKernel(RBFKernel)
    kernel = gp.covar_module
    matern_scale = kernel.kernels[0]  # ScaleKernel wrapping MaternKernel
    rbf_scale = kernel.kernels[1]  # ScaleKernel wrapping RBFKernel

    # Input transform parameters
    input_tf = gp.input_transform
    # tf1: AffineInputTransform (time + 1)
    # tf2: Log10 (time dimension)
    # tf3: Normalize (all dims to [0,1])
    tf3 = input_tf["tf3"]  # Normalize
    normalize_bounds = tf3.bounds.detach()  # (2, d) in transformed space

    # Output transform
    otf = gp.outcome_transform
    y_mean = otf.means.squeeze().item()
    y_std = otf.stdvs.squeeze().item()

    # Training data (already transformed by input_transform during fitting)
    train_X = gp.train_inputs[0].detach()
    train_Y = gp.train_targets.detach()

    # Compute Cholesky and alpha for posterior predictions
    with torch.no_grad():
        prior_dist = gp.forward(train_X)
        noisy_mvn = gp.likelihood(prior_dist)
        K = noisy_mvn.lazy_covariance_matrix.to_dense()

    L = psd_safe_cholesky(K)
    # alpha = K^{-1} (Y_standardized - prior_mean)
    # Note: for SingleTaskGP, prior_mean is the constant mean (usually 0 in std space)
    residuals = (train_Y - prior_dist.mean).unsqueeze(-1)
    alpha = torch.cholesky_solve(residuals, L).squeeze(-1)

    # Noise variance
    noise_var = gp.likelihood.noise_covar.noise.item()

    # Heteroscedastic noise: check if using PartialFixedNoiseLikelihood
    from boxcrete.models import PartialFixedNoiseLikelihood

    if isinstance(gp.likelihood, PartialFixedNoiseLikelihood):
        n_real = gp.likelihood.n_real
        pseudo_noise = gp.likelihood.pseudo_noise
    else:
        n_real = train_X.shape[0]  # all observations treated equally
        pseudo_noise = noise_var  # same as learned noise

    # Time dimension index
    d_in = train_X.shape[-1]
    time_dim = d_in - 1

    params = {
        "d_in": d_in,
        "time_dim": time_dim,
        "n_train": train_X.shape[0],
        "n_real": n_real,
        "pseudo_noise": pseudo_noise,
        # Kernel hyperparameters
        "matern_lengthscales": to_list(matern_scale.base_kernel.lengthscale.squeeze()),
        "matern_outputscale": matern_scale.outputscale.item(),
        "rbf_lengthscale": rbf_scale.base_kernel.lengthscale.squeeze().item(),
        "rbf_outputscale": rbf_scale.outputscale.item(),
        "noise_variance": noise_var,
        # Input transform: normalize bounds (in log-transformed space)
        "normalize_lower": to_list(normalize_bounds[0]),
        "normalize_upper": to_list(normalize_bounds[1]),
        # Output transform
        "y_mean": y_mean,
        "y_std": y_std,
        # Prior mean in standardized space
        "prior_mean": prior_dist.mean[0].item(),
        # Training data (transformed) — L and alpha recomputed in JS on load
        "X_train": to_list(train_X),
        # Standardized training targets (for recomputing alpha in JS)
        "Y_train": to_list(train_Y),
    }

    path = os.path.join(OUTPUT_DIR, "strength.json")
    with open(path, "w") as f:
        json.dump(params, f, separators=(",", ":"))
    print(f"Exported strength model: {path} ({os.path.getsize(path) / 1024:.0f} KB)")
    return params


def export_gwp_model(model, data):
    """Export GWP linear model coefficients."""
    # Use the stored coefficients directly
    params = {
        "coefficients": {},
        "class_dim": None,
        "column_names": data.X_columns[:-1],  # without Time
    }

    # Check if model uses class-indexed coefficients
    gwp = model.gwp_model
    if gwp._class_dim is not None:
        params["class_dim"] = gwp._class_dim
        # Export per-class coefficients
        for cls_idx in range(gwp._coefficients.shape[0]):
            params["coefficients"][str(cls_idx)] = {
                "means": to_list(gwp._coefficients[cls_idx]),
                "variances": to_list(gwp._coefficient_vars[cls_idx]),
            }
    else:
        params["coefficients"]["0"] = {
            "means": to_list(gwp._coefficients),
            "variances": to_list(gwp._coefficient_vars),
        }

    path = os.path.join(OUTPUT_DIR, "gwp.json")
    with open(path, "w") as f:
        json.dump(params, f, separators=(",", ":"))
    print(f"Exported GWP model: {path} ({os.path.getsize(path) / 1024:.0f} KB)")

    # Export cost model coefficients
    cost = model.cost_model
    cost_params = {
        "coefficients": {
            "means": to_list(cost._coefficients.squeeze()),
            "variances": to_list(cost._coefficient_vars.squeeze()),
        },
    }
    cost_path = os.path.join(OUTPUT_DIR, "cost.json")
    with open(cost_path, "w") as f:
        json.dump(cost_params, f, separators=(",", ":"))
    print(
        f"Exported Cost model: {cost_path} ({os.path.getsize(cost_path) / 1024:.0f} KB)"
    )

    return params


def export_compositions(model, data):
    """Export training compositions with predictions for scatter plot."""
    # Get unique compositions (without time)
    X_gwp, Y_gwp, _, _ = data.gwp_data
    compositions = X_gwp.detach()

    # Predict GWP for each composition
    with torch.no_grad():
        gwp_post = model.gwp_model.posterior(compositions)
        gwp_means = gwp_post.mean.squeeze(-1)

    # Predict Cost for each composition
    with torch.no_grad():
        cost_post = model.cost_model.posterior(compositions)
        cost_means = cost_post.mean.squeeze(-1)

    # Predict strength at each day (need full model with time)
    strength_preds = {}
    for day in STRENGTH_DAYS:
        X_with_time = torch.cat(
            [compositions, torch.full((compositions.shape[0], 1), float(day))],
            dim=-1,
        )
        with torch.no_grad():
            post = model.strength_model.posterior(X_with_time)
            strength_preds[str(day)] = to_list(post.mean.squeeze(-1))

    # Compute Pareto mask (GWP vs 28-day strength, both maximized in model space)
    from botorch.utils.multi_objective import is_non_dominated

    Y_pareto = torch.stack([gwp_means, torch.tensor(strength_preds["28"])], dim=-1)
    pareto_mask = is_non_dominated(Y_pareto)

    # Bounds for sliders (from training data range)
    col_names = data.X_columns[:-1]
    slider_bounds = {}
    for i, col in enumerate(col_names):
        slider_bounds[col] = {
            "min": compositions[:, i].min().item(),
            "max": compositions[:, i].max().item(),
        }

    # Export raw observations grouped by composition index
    # (for overlaying on strength curve plot)
    X_str, Y_str, _, _ = data.strength_data
    X_comps_str = X_str[:, :-1]  # compositions without time
    X_time_str = X_str[:, -1]  # time column
    observations = {}  # {comp_idx: [[time, strength], ...]}
    for i in range(X_str.shape[0]):
        comp = X_comps_str[i]
        # Find matching composition index
        dists = (compositions - comp).abs().sum(dim=-1)
        match_idx = dists.argmin().item()
        if dists[match_idx].item() < 1e-3:  # close enough match
            key = str(match_idx)
            if key not in observations:
                observations[key] = []
            observations[key].append([X_time_str[i].item(), Y_str[i, 0].item()])

    params = {
        "column_names": col_names,
        "compositions": to_list(compositions),
        "gwp_predictions": to_list(gwp_means),
        "cost_predictions": to_list(cost_means),
        "strength_predictions": strength_preds,
        "pareto_mask": to_list(pareto_mask.float()),
        "slider_bounds": slider_bounds,
        "n_compositions": compositions.shape[0],
        "observations": observations,
    }

    path = os.path.join(OUTPUT_DIR, "compositions.json")
    with open(path, "w") as f:
        json.dump(params, f, separators=(",", ":"))
    print(f"Exported compositions: {path} ({os.path.getsize(path) / 1024:.0f} KB)")
    return params


def export_test_vectors(model, data):
    """Export reference predictions for CI sync testing."""
    # Select 15 diverse test compositions (evenly spaced indices)
    X_gwp, _, _, _ = data.gwp_data
    n = X_gwp.shape[0]
    indices = torch.linspace(0, n - 1, 15).long()
    test_compositions = X_gwp[indices]

    vectors = []
    for i, comp in enumerate(test_compositions):
        comp_unsqueezed = comp.unsqueeze(0)

        # GWP prediction
        with torch.no_grad():
            gwp_post = model.gwp_model.posterior(comp_unsqueezed)
            gwp_mean = gwp_post.mean.squeeze().item()
            gwp_var = gwp_post.variance.squeeze().item()

        # Strength predictions at each day
        strength = {}
        for day in STRENGTH_DAYS:
            X_t = torch.cat([comp_unsqueezed, torch.tensor([[float(day)]])], dim=-1)
            with torch.no_grad():
                post = model.strength_model.posterior(X_t)
                strength[str(day)] = {
                    "mean": post.mean.squeeze().item(),
                    "variance": post.variance.squeeze().item(),
                }

        vectors.append(
            {
                "input": to_list(comp),
                "gwp_mean": gwp_mean,
                "gwp_variance": gwp_var,
                "strength": strength,
            }
        )

    params = {"test_vectors": vectors, "strength_days": STRENGTH_DAYS}

    path = os.path.join(OUTPUT_DIR, "test_vectors.json")
    with open(path, "w") as f:
        json.dump(params, f, indent=2)
    print(f"Exported test vectors: {path}")
    return params


def main():
    os.makedirs(OUTPUT_DIR, exist_ok=True)

    print("Loading data...")
    data = load_concrete_strength()

    print("Fitting model...")
    model = SustainableConcreteModel(strength_days=STRENGTH_DAYS)
    model.fit_gwp_model(data)
    model.fit_cost_model(data)
    model.fit_strength_model(data, use_fixed_noise=False)

    print("\nExporting model parameters...")
    export_strength_model(model, data)
    export_gwp_model(model, data)
    export_compositions(model, data)
    export_test_vectors(model, data)

    print("\nDone! Files written to docs/model/")


if __name__ == "__main__":
    main()
