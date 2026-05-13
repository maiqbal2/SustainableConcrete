#!/usr/bin/env python3
# Copyright (c) Meta Platforms, Inc. and affiliates.
#
# This source code is licensed under the MIT license found in the
# LICENSE file in the root directory of this source tree.

"""Reproducible study: lengthscale-prior comparison on the public dataset.

Reproduces the empirical sweep that motivated the production
``WithinGroupShrinkagePrior`` in ``boxcrete/models.py::fit_strength_gp``.
For each prior variant we fit the strength GP on the 647 public strength
rows and compute analytical leave-one-out (LOO) cross-validation
predictive RMSE / log-density at the fitted hyperparameters.

Variants compared (all evaluated on the same 647 public LOO targets):

    A) no prior — Fly Ash & Coarse Aggregates lengthscales rail to the
       optimiser's upper bound, so their explorer sliders become
       unresponsive.
    B) within-group shrinkage on {Cement, FA, Slag} & {Fine, Coarse} at
       three widths sigma in {0.5, 0.1, 0.001}; sigma=0.001 is production.

Run::

    python scripts/lengthscale_prior_study.py
    python scripts/lengthscale_prior_study.py --seeds 0 1 2 3 4

Expected ranking (lower RMSE is better):

    no prior          ~ 772 psi   <- cap-failure on FA + CA
    shrinkage s=0.5   ~ 754 psi   <- all lengthscales identifiable
    shrinkage s=0.1   ~ 731 psi
    shrinkage s=0.001 ~ 725 psi   <- production setting

The sigma -> 0 limit Pareto-dominates every alternative we tested. See
the ``WithinGroupShrinkagePrior`` docstring for the full comparison.
"""

from __future__ import annotations

import argparse
import math
import sys
from pathlib import Path

REPO_DIR = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REPO_DIR))

import torch  # noqa: E402

from boxcrete import compute_loo_cv  # noqa: E402
from boxcrete.models import (  # noqa: E402
    WithinGroupShrinkagePrior,
    _AGGREGATE_LENGTHSCALE_GROUP,
    _BINDER_LENGTHSCALE_GROUP,
    fit_strength_gp,
)
from boxcrete.utils import load_concrete_strength  # noqa: E402

FEATURE_NAMES = (
    "Cement",
    "Fly Ash",
    "Slag",
    "Water",
    "HRWR",
    "Fine Aggregate",
    "Coarse Aggregates",
    "Material Source",
    "Temp",
    "Time",
)


def make_prior(sigma: float, d_in: int) -> WithinGroupShrinkagePrior:
    """Builds a within-group shrinkage prior with width ``sigma`` on
    both the binder and aggregate groups."""
    return WithinGroupShrinkagePrior(
        groups_with_sigma=[
            (_BINDER_LENGTHSCALE_GROUP, sigma),
            (_AGGREGATE_LENGTHSCALE_GROUP, sigma),
        ],
        dim=d_in,
    )


def loo_metrics(model, n_real: int) -> dict[str, float]:
    """Returns ``{rmse, mae, mean_lpd}`` for the GP's analytical LOO at the
    fitted hyperparameters. Thin wrapper around ``boxcrete.compute_loo_cv``;
    only the first ``n_real`` rows are scored (the day-zero anchors that
    ``fit_strength_gp`` appends are excluded)."""
    obs, mean, std = compute_loo_cv(model, n_real=n_real)
    err = mean - obs
    log_pd = -0.5 * (err**2 / std**2) - std.log() - 0.5 * math.log(2 * math.pi)
    return {
        "rmse": ((err**2).mean().sqrt()).item(),
        "mae": err.abs().mean().item(),
        "mean_lpd": log_pd.mean().item(),
    }


def fit_and_score(X, Y, Yvar, X_bounds, lengthscale_prior, seed: int) -> dict:
    """Fit one strength GP and return its LOO metrics + lengthscales."""
    torch.manual_seed(seed)
    model = fit_strength_gp(
        X=X,
        Y=Y,
        Yvar=Yvar,
        X_bounds=X_bounds,
        use_fixed_noise=False,
        lengthscale_prior=lengthscale_prior,
    )
    n_real = X.shape[0]  # fit_strength_gp appends day-zero anchors AFTER X
    metrics = loo_metrics(model=model, n_real=n_real)
    metrics["matern_lengthscales"] = (
        model.covar_module.kernels[0]
        .base_kernel.lengthscale.detach()
        .squeeze()
        .tolist()
    )
    return metrics


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Lengthscale-prior LOO comparison on the public dataset.",
    )
    parser.add_argument(
        "--seeds",
        type=int,
        nargs="+",
        default=[0, 1, 2, 3, 4],
        help="PyTorch seeds to average over (default: %(default)s).",
    )
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> None:
    args = parse_args(argv)

    print("Loading public training data from data/boxcrete_data.csv ...")
    data = load_concrete_strength()
    X, Y, Yvar, X_bounds = data.strength_data
    n, d = X.shape
    print(f"  {n} strength rows, {d} input dims, seeds={args.seeds}\n")

    variants = [
        ("A: no prior", None),
        ("B1: within-group shrinkage sigma=0.5", make_prior(0.5, d)),
        ("B2: within-group shrinkage sigma=0.1", make_prior(0.1, d)),
        ("B3: within-group shrinkage sigma=0.001 (production)", make_prior(0.001, d)),
    ]

    rows = []
    for label, prior in variants:
        print(f"--- {label} ---")
        rmses = []
        last_ls = None
        for seed in args.seeds:
            r = fit_and_score(X, Y, Yvar, X_bounds, prior, seed=seed)
            rmses.append(r["rmse"])
            last_ls = r["matern_lengthscales"]
            print(
                f"  seed={seed}: RMSE={r['rmse']:>6.1f}  "
                f"meanLPD={r['mean_lpd']:>+5.2f}  "
                f"FA={last_ls[1]:>6.2f}  CoA={last_ls[6]:>6.2f}"
            )
        m = sum(rmses) / len(rmses)
        std = (sum((x - m) ** 2 for x in rmses) / len(rmses)) ** 0.5
        rows.append((label, m, std, min(rmses), max(rmses), last_ls))
        print()

    print("=" * 80)
    print(f"  {'variant':<55s}  {'mean RMSE':>10}  {'std':>6}")
    print("  " + "-" * 76)
    for label, m, std, lo, hi, _ in rows:
        print(f"  {label:<55s}  {m:>10.1f}  {std:>6.2f}")
    print("=" * 80)
    print("\nProduction setting (B3) and the no-prior baseline (A) are the")
    print("two reference points for the regression test in")
    print("test/test_lengthscale_identifiability.py.")


if __name__ == "__main__":
    main()
