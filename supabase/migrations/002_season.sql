alter table clan_snapshots add column season int;
create table sync_runs (
  id bigint generated always as identity primary key,
  captured_at timestamptz not null default now(),
  season int not null,
  total_rep bigint not null
);
alter table sync_runs enable row level security;
create policy "public read" on sync_runs for select using (true);

-- Existing snapshots were taken while Season 3 was closing
update clan_snapshots set season = 3 where season is null;
insert into sync_runs (season, total_rep)
select 3, coalesce(sum(reputation), 0) from clan_snapshots
where captured_at = (select max(captured_at) from clan_snapshots);

drop view clan_latest;
create view clan_latest with (security_invoker = true) as
select * from (
  select c.name, c.master, s.captured_at, s.rank, s.members, s.max_members, s.reputation, s.season,
    s.reputation - lag(s.reputation) over w as rep_delta,
    lag(s.rank) over w - s.rank as rank_move,
    row_number() over (partition by s.clan_id order by s.captured_at desc) as rn
  from clan_snapshots s join clans c on c.id = s.clan_id
  window w as (partition by s.clan_id, s.season order by s.captured_at)
) t where rn = 1;
