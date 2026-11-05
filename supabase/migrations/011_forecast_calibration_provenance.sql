-- Persist the calibration decision with every forecast so accuracy reports can
-- distinguish confirmed adjusted forecasts from baseline and unavailable-history rows.
alter table public.clan_forecasts
  add column calibration_status text not null default 'not_calibrated',
  add column calibration_sample_count smallint not null default 0,
  add column calibration_median_relative_error_pct numeric(8, 3),
  add column calibration_adjustment_pct numeric(8, 3);

alter table public.clan_forecasts
  add constraint clan_forecasts_calibration_status_check
    check (calibration_status in ('not_calibrated', 'insufficient_data', 'calibrated', 'history_unavailable')),
  add constraint clan_forecasts_calibration_sample_count_check
    check (calibration_sample_count between 0 and 10);
