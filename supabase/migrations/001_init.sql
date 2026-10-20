create table clans (
  id bigint generated always as identity primary key,
  name text unique not null,
  master text
);
create table clan_snapshots (
  id bigint generated always as identity primary key,
  clan_id bigint not null references clans(id) on delete cascade,
  captured_at timestamptz not null default now(),
  rank int, members int, max_members int, reputation bigint
);
create index on clan_snapshots (clan_id, captured_at desc);
create table war_results (
  season int not null, rank int not null,
  clan_name text not null, members int, reputation bigint, ended_on date,
  primary key (season, rank)
);
create view clan_latest with (security_invoker = true) as
select * from (
  select c.name, c.master, s.captured_at, s.rank, s.members, s.max_members, s.reputation,
    s.reputation - lag(s.reputation) over w as rep_delta,
    lag(s.rank) over w - s.rank as rank_move,
    row_number() over (partition by s.clan_id order by s.captured_at desc) as rn
  from clan_snapshots s join clans c on c.id = s.clan_id
  window w as (partition by s.clan_id order by s.captured_at)
) t where rn = 1;
alter table clans enable row level security;
alter table clan_snapshots enable row level security;
alter table war_results enable row level security;
create policy "public read" on clans for select using (true);
create policy "public read" on clan_snapshots for select using (true);
create policy "public read" on war_results for select using (true);
