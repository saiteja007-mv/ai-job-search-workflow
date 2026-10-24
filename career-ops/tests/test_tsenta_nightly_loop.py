#!/usr/bin/env python3
"""Unit tests for the Tsenta nightly success-loop (scripts/run_tsenta_nightly_direct.py).

No network: mcp_call is monkeypatched with an in-memory FakeTsenta. Time is
injectable: _sleep/_now_utc are monkeypatched so the loop runs in seconds.

Run: python3 -m unittest tests/test_tsenta_nightly_loop.py -v
"""
import importlib.util
import sys
import tempfile
import unittest
from collections import Counter
from datetime import date, datetime, timedelta, timezone
from pathlib import Path
from zoneinfo import ZoneInfo

ROOT = Path(__file__).resolve().parents[1]
SCRIPT = ROOT / 'scripts' / 'run_tsenta_nightly_direct.py'

spec = importlib.util.spec_from_file_location('run_tsenta_nightly_direct', SCRIPT)
mod = importlib.util.module_from_spec(spec)
sys.modules['run_tsenta_nightly_direct'] = mod
spec.loader.exec_module(mod)

TZ = ZoneInfo('America/Chicago')


class FakeTsenta:
    """Minimal in-memory stand-in for the tsenta MCP server.

    apply_to_job -> PENDING_RESUME_REVIEW (debits balance immediately)
    approve_application -> RUNNING
    Each list_applications(filter='all') call ticks RUNNING apps down;
    at ticks_left<=0 they resolve to their scripted final_status, refunding
    the balance on FAILED/SKIPPED (Tsenta's real refund behavior).
    """

    def __init__(self, balance=1000, now_fn=None):
        self.jobs = {}
        self.resolve_ticks = {}
        self.final_status = {}
        self.apps = []
        self.balance_total = balance
        self.apply_calls = []
        self.approve_calls = []
        self._seq = 0
        self.now_fn = now_fn or (lambda: datetime.now(timezone.utc))
        # Failure-injection knobs for the loop-safety tests below. All
        # default to "never fail" so every existing test is unaffected.
        self.raise_on_next_apply = 0       # apply_to_job raises N times, no rows created
        self.fail_balance_checks = False   # get_application_balance always raises
        self._list_all_calls = 0
        self.fail_list_all_on_call = None  # list_applications(filter='all') raises on this 1-based call #

    def add_job(self, jid, title, company, match=1.0, supported=True,
                employment='FULL_TIME', sponsorship='NO_SPONSORSHIP', text=''):
        self.jobs[jid] = {
            'id': jid, 'title': title, 'companyName': company, 'matchScore': match,
            'isSupportedAts': supported, 'employmentType': employment,
            'sponsorship': sponsorship, 'description': text,
        }

    def seed_existing_app(self, job_id, status, created_at):
        self._seq += 1
        self.apps.append({
            'applicationId': f'seed{self._seq}', 'jobId': job_id, 'status': status,
            'createdAt': created_at.isoformat().replace('+00:00', 'Z'),
            'ticks_left': 0, 'final_status': status, 'approved': True,
        })

    def handle(self, tool, args):
        if tool == 'get_application_balance':
            if self.fail_balance_checks:
                raise RuntimeError('simulated get_application_balance failure')
            return {'total': self.balance_total}
        if tool == 'get_job_recommendations':
            return {'jobs': list(self.jobs.values())}
        if tool == 'get_jobs_by_ids':
            ids = args.get('jobIds', [])
            return {'jobs': [self.jobs[i] for i in ids if i in self.jobs]}
        if tool == 'apply_to_job':
            if self.raise_on_next_apply > 0:
                self.raise_on_next_apply -= 1
                # Genuine no-op failure: nothing recorded, no row created,
                # no balance touched -- unlike the documented "SSE ended but
                # row was created" case.
                raise RuntimeError('simulated transient apply_to_job failure (no rows created)')
            ids = list(args.get('jobIds', []))
            self.apply_calls.append(ids)
            for jid in ids:
                self._seq += 1
                self.apps.append({
                    'applicationId': f'app{self._seq}', 'jobId': jid,
                    'status': 'PENDING_RESUME_REVIEW',
                    'createdAt': self.now_fn().isoformat().replace('+00:00', 'Z'),
                    'ticks_left': self.resolve_ticks.get(jid, 1),
                    'final_status': self.final_status.get(jid, 'COMPLETED'),
                    'approved': False,
                })
            self.balance_total -= len(ids)
            return {'ok': True}
        if tool == 'approve_application':
            aid = args['applicationId']
            self.approve_calls.append(aid)
            for a in self.apps:
                if a['applicationId'] == aid:
                    a['approved'] = True
                    a['status'] = 'RUNNING'
            return {'ok': True}
        if tool == 'list_applications':
            filt = args.get('filter')
            if filt == 'all':
                self._list_all_calls += 1
                if self.fail_list_all_on_call == self._list_all_calls:
                    raise RuntimeError('simulated transient list_applications failure')
                self._advance()
            if filt == 'needs':
                rows = [a for a in self.apps if a['status'] == 'PENDING_RESUME_REVIEW']
            else:
                rows = list(self.apps)
            return {
                'applications': [self._public(a) for a in rows],
                'pagination': {'totalPages': 1},
            }
        raise AssertionError(f'unexpected mcp tool: {tool}')

    def _advance(self):
        for a in self.apps:
            if a['status'] == 'RUNNING':
                a['ticks_left'] -= 1
                if a['ticks_left'] <= 0:
                    a['status'] = a['final_status']
                    if a['final_status'] in ('FAILED', 'SKIPPED'):
                        self.balance_total += 1

    @staticmethod
    def _public(a):
        return {k: a[k] for k in ('applicationId', 'jobId', 'status', 'createdAt')}


class LoopTestCase(unittest.TestCase):
    def setUp(self):
        self.fake = FakeTsenta()
        self._orig_mcp_call = mod.mcp_call
        self._orig_sleep = mod._sleep
        self._orig_now = mod._now_utc
        mod.mcp_call = lambda tool, args: self.fake.handle(tool, args)
        mod._sleep = lambda s: None  # no real waiting -> tests run in seconds
        # Pin the clock to the fixtures' night (2026-09-25 22:00 CDT): the real clock made every test
        # hit its fixed 2026-09-26 deadline once that date passed. Tests that need time to move set their own.
        mod._now_utc = lambda: datetime(2026, 9, 26, 3, 0, tzinfo=timezone.utc)
        self.today = date(2026, 9, 25)
        self.blockers = []
        self.skipped_reasons = Counter()

    def tearDown(self):
        mod.mcp_call = self._orig_mcp_call
        mod._sleep = self._orig_sleep
        mod._now_utc = self._orig_now

    def run_loop(self, **overrides):
        # run_started_at_utc must be <= the fake's (real wall-clock) app
        # creation time, or approve_pending's cutoff filter rejects every
        # row it just created and nothing ever leaves PENDING_RESUME_REVIEW.
        kwargs = dict(
            target=3, total_before=1000, today_local=self.today, tz=TZ,
            run_started_at_utc=datetime(2020, 1, 1, tzinfo=timezone.utc).isoformat().replace('+00:00', 'Z'),
            deadline_utc=datetime(2026, 9, 26, 10, 24, tzinfo=timezone.utc),
            attempt_cap=30, dry_run=False, pulls=[{}],
            blockers=self.blockers, skipped_reasons=self.skipped_reasons,
        )
        kwargs.update(overrides)
        return mod.apply_loop(**kwargs)

    # -- filter: NO_SPONSORSHIP no longer skipped, citizenship/clearance still is --
    def test_no_sponsorship_not_skipped_citizenship_still_skipped(self):
        candidates = [
            {'id': 'j1', 'title': 'Machine Learning Engineer', 'companyName': 'Acme',
             'isSupportedAts': True, 'employmentType': 'FULL_TIME', 'sponsorship': 'NO_SPONSORSHIP'},
            {'id': 'j2', 'title': 'Machine Learning Engineer', 'companyName': 'Fedco',
             'isSupportedAts': True, 'employmentType': 'FULL_TIME', 'sponsorship': 'WILL_SPONSOR'},
        ]
        details = {'j2': {'description': 'Must be a U.S. Citizen. Active secret clearance required.'}}
        skips = Counter()
        eligible = mod.filter_candidates(candidates, details, set(), skips)
        ids = {j['id'] for j in eligible}
        self.assertIn('j1', ids, 'NO_SPONSORSHIP must no longer be a skip reason')
        self.assertNotIn('j2', ids, 'citizenship/clearance text must still be a hard skip')
        self.assertNotIn('no sponsorship', skips)
        self.assertEqual(skips.get('citizenship/clearance/export-control risk'), 1)

    # -- dry run makes zero apply/approve calls --
    def test_dry_run_zero_calls(self):
        self.fake.add_job('j1', 'Machine Learning Engineer', 'Acme')
        self.fake.add_job('j2', 'Data Scientist', 'Beta')
        result = self.run_loop(target=5, dry_run=True)
        self.assertEqual(result['stop_reason'], 'dry_run')
        self.assertEqual(self.fake.apply_calls, [])
        self.assertEqual(self.fake.approve_calls, [])
        self.assertEqual(result['pool_size'], 2)
        self.assertLessEqual(len(result['would_apply']), 5)

    # -- backfills FAILED/SKIPPED until successes == target --
    def test_backfills_failures_until_target_reached(self):
        for i in range(5):
            self.fake.add_job(f'j{i}', 'Machine Learning Engineer', f'Co{i}')
        # first 3 applied: 2 complete, 1 fails (refunds + reopens the gap)
        self.fake.final_status = {'j0': 'COMPLETED', 'j1': 'COMPLETED', 'j2': 'FAILED', 'j3': 'COMPLETED', 'j4': 'COMPLETED'}
        self.fake.resolve_ticks = {k: 1 for k in self.fake.jobs}
        result = self.run_loop(target=3, attempt_cap=30)
        self.assertEqual(result['stop_reason'], 'target reached')
        self.assertEqual(result['successes_today'], 3)
        self.assertGreaterEqual(result['attempts'], 4)  # 3 initial + >=1 backfill replacement
        self.assertEqual(result['failed_refunded'], 1)

    # -- stops at candidate pool exhaustion --
    def test_stops_at_pool_exhaustion(self):
        for i in range(3):
            self.fake.add_job(f'j{i}', 'Machine Learning Engineer', f'Co{i}')
        self.fake.final_status = {k: 'COMPLETED' for k in self.fake.jobs}
        self.fake.resolve_ticks = {k: 1 for k in self.fake.jobs}
        result = self.run_loop(target=10)
        self.assertEqual(result['stop_reason'], 'candidate pool exhausted')
        self.assertEqual(result['successes_today'], 3)

    # -- stops when the live balance is exhausted; never over-applies it --
    def test_stops_at_balance_exhausted(self):
        for i in range(5):
            self.fake.add_job(f'j{i}', 'Machine Learning Engineer', f'Co{i}')
        self.fake.final_status = {k: 'COMPLETED' for k in self.fake.jobs}
        self.fake.resolve_ticks = {k: 1 for k in self.fake.jobs}
        self.fake.balance_total = 2
        result = self.run_loop(target=10, total_before=2)
        self.assertEqual(result['stop_reason'], 'balance exhausted')
        self.assertLessEqual(result['attempts'], 2)
        self.assertEqual(result['successes_today'], 2)

    # -- stops at the hard attempt cap (3x target), never overshoots it --
    def test_stops_at_attempt_cap(self):
        for i in range(10):
            self.fake.add_job(f'j{i}', 'Machine Learning Engineer', f'Co{i}')
        # every application fails -> gap never closes, forcing the cap to fire
        self.fake.final_status = {k: 'FAILED' for k in self.fake.jobs}
        self.fake.resolve_ticks = {k: 1 for k in self.fake.jobs}
        result = self.run_loop(target=10, attempt_cap=4)
        self.assertEqual(result['stop_reason'], 'attempt cap')
        self.assertLessEqual(result['attempts'], 4)

    # -- stops at the deadline --
    def test_stops_at_deadline(self):
        self.fake.add_job('j0', 'Machine Learning Engineer', 'Co0')
        past_deadline = datetime(2026, 9, 26, 1, 0, tzinfo=timezone.utc)
        mod._now_utc = lambda: datetime(2026, 9, 26, 2, 0, tzinfo=timezone.utc)
        result = self.run_loop(target=5, deadline_utc=past_deadline)
        self.assertEqual(result['stop_reason'], 'deadline')
        self.assertEqual(self.fake.apply_calls, [])

    # -- same-day rerun: earlier-run successes count toward the target --
    def test_counts_earlier_successes_same_day(self):
        created_earlier_today = datetime(2026, 9, 25, 14, 0, tzinfo=timezone.utc)  # 09:00 CDT
        self.fake.seed_existing_app('old1', 'COMPLETED', created_earlier_today)
        self.fake.seed_existing_app('old2', 'COMPLETED', created_earlier_today)
        self.fake.add_job('new1', 'Machine Learning Engineer', 'Co1')
        self.fake.final_status = {'new1': 'COMPLETED'}
        self.fake.resolve_ticks = {'new1': 1}
        result = self.run_loop(target=3)
        self.assertEqual(result['stop_reason'], 'target reached')
        self.assertEqual(result['successes_today'], 3)
        self.assertEqual(result['attempts'], 1, 'must only backfill the remaining gap, not redo the earlier 2')

    # -- cycle-wide dedupe: a jobId already applied (any status) is excluded --
    def test_dedupes_against_full_application_history_not_just_today(self):
        yesterday = datetime(2026, 9, 20, 12, 0, tzinfo=timezone.utc)
        self.fake.seed_existing_app('dup', 'FAILED', yesterday)
        self.fake.add_job('dup', 'Machine Learning Engineer', 'CoDup')
        self.fake.add_job('fresh', 'Machine Learning Engineer', 'CoFresh')
        self.fake.final_status = {'fresh': 'COMPLETED'}
        self.fake.resolve_ticks = {'fresh': 1}
        result = mod.apply_loop(
            target=1, total_before=1000, today_local=self.today, tz=TZ,
            run_started_at_utc=datetime(2020, 1, 1, tzinfo=timezone.utc).isoformat().replace('+00:00', 'Z'),
            deadline_utc=datetime(2026, 9, 26, 10, 0, tzinfo=timezone.utc),
            attempt_cap=30, dry_run=True, pulls=[{}],
            blockers=self.blockers, skipped_reasons=self.skipped_reasons,
        )
        self.assertEqual(result['pool_size'], 1, 'dup jobId (any prior status) must be excluded from the pool')
        would_ids = {j['id'] for j in result['would_apply']}
        self.assertIn('fresh', would_ids)
        self.assertNotIn('dup', would_ids)

    # -- review fix: a backfill created after local midnight (this run's own
    # session) must still close the loop's own gap, not just same-date rows --
    def test_gap_closes_for_run_scoped_completions_after_local_midnight(self):
        # Run launched 23:55 CDT on 2026-09-25 == 04:55 UTC on 2026-09-26.
        # Local midnight is 05:00 UTC. j0 fails (ticks through the boundary),
        # freeing a backfill (j2) that gets APPLIED after the clock has
        # crossed local midnight -- its createdAt date is Sep26, not
        # today_local (Sep25).
        clock = {'t': datetime(2026, 9, 26, 4, 55, 0, tzinfo=timezone.utc)}
        mod._now_utc = lambda: clock['t']
        def sleep(s):
            clock['t'] += timedelta(seconds=s)
        mod._sleep = sleep
        self.fake = FakeTsenta(now_fn=lambda: clock['t'])

        self.fake.add_job('j0', 'Machine Learning Engineer', 'Co0', match=3)
        self.fake.add_job('j1', 'Machine Learning Engineer', 'Co1', match=2)
        self.fake.add_job('j2', 'Machine Learning Engineer', 'Co2', match=1)
        self.fake.final_status = {'j0': 'FAILED', 'j1': 'COMPLETED', 'j2': 'COMPLETED'}
        self.fake.resolve_ticks = {'j0': 6, 'j1': 6, 'j2': 1}

        run_started = clock['t'].isoformat().replace('+00:00', 'Z')
        result = mod.apply_loop(
            target=2, total_before=1000, today_local=date(2026, 9, 25), tz=TZ,
            run_started_at_utc=run_started,
            deadline_utc=datetime(2026, 9, 27, 0, 0, tzinfo=timezone.utc),
            attempt_cap=30, dry_run=False, pulls=[{}],
            blockers=self.blockers, skipped_reasons=self.skipped_reasons,
        )
        self.assertEqual(result['stop_reason'], 'target reached')
        self.assertEqual(result['successes_today'], 2, 'the post-midnight backfill completion must count toward this run\'s own gap')

    # -- review fix: a transient list_applications poll failure inside the
    # loop must not crash the run (previously propagated all the way out of
    # apply_loop / main()'s unguarded try/finally) --
    def test_transient_poll_failure_does_not_crash_loop(self):
        for i in range(3):
            self.fake.add_job(f'j{i}', 'Machine Learning Engineer', f'Co{i}')
        self.fake.final_status = {k: 'COMPLETED' for k in self.fake.jobs}
        self.fake.resolve_ticks = {k: 1 for k in self.fake.jobs}
        self.fake.fail_list_all_on_call = 2  # the first in-loop poll (call #1 is the pre-loop fetch)
        result = self.run_loop(target=1, attempt_cap=10)
        self.assertEqual(result['stop_reason'], 'target reached')
        self.assertGreaterEqual(result['successes_today'], 1)
        self.assertTrue(any('list_applications poll failed' in b for b in self.blockers))

    # -- review fix: a stale (never-refreshed) local balance must not let
    # the loop apply past the true live balance --
    def test_stale_balance_check_failure_does_not_overapply(self):
        for i in range(5):
            self.fake.add_job(f'j{i}', 'Machine Learning Engineer', f'Co{i}')
        self.fake.final_status = {k: 'COMPLETED' for k in self.fake.jobs}
        self.fake.resolve_ticks = {k: 1 for k in self.fake.jobs}
        self.fake.fail_balance_checks = True
        result = self.run_loop(target=10, total_before=2, attempt_cap=30)
        self.assertEqual(result['stop_reason'], 'balance exhausted')
        self.assertLessEqual(result['attempts'], 2, 'a stale balance (check always failing) must not let the loop over-apply past the live 2-credit balance')

    # -- review fix: an apply_to_job call that raises with no rows created
    # must leave the candidate in the pool for retry, not silently discard it --
    def test_apply_failure_retries_without_losing_candidate(self):
        self.fake.add_job('j0', 'Machine Learning Engineer', 'Co0')
        self.fake.final_status = {'j0': 'COMPLETED'}
        self.fake.resolve_ticks = {'j0': 1}
        self.fake.raise_on_next_apply = 1  # first apply_to_job call fails, no rows created
        result = self.run_loop(target=1, attempt_cap=10)
        self.assertEqual(result['stop_reason'], 'target reached')
        self.assertEqual(result['successes_today'], 1)
        self.assertEqual(len(self.fake.apply_calls), 1, 'the failed call created no row and must not be counted as an apply')
        self.assertEqual(result['attempts'], 1, 'the discarded failed attempt must not inflate attempts; the retry is what got credited')
        self.assertTrue(any('created no rows' in b or 'apply batch failed' in b for b in self.blockers))

    # -- review fix: BAD_TEXT must catch the plural "US Citizens/Green Cards"
    # slash form (live gap found 2026-09-25), while staying case/order-loose --
    def test_bad_text_catches_us_citizens_green_cards_slash(self):
        candidates = [{
            'id': 'j477e',
            'title': 'AI/ML Data Engineer- Hybrid (US Citizens/ Green Cards- Local to DMV only)',
            'companyName': 'Swingtech', 'isSupportedAts': True, 'employmentType': 'FULL_TIME',
        }]
        skips = Counter()
        eligible = mod.filter_candidates(candidates, {}, set(), skips)
        self.assertEqual(eligible, [], 'a US Citizens/Green Cards requirement must still be a hard block')
        self.assertEqual(skips.get('citizenship/clearance/export-control risk'), 1)

    # -- stall fix 1/3: a PENDING_RESUME_REVIEW row that only shows up while the
    # loop is idling in a WAIT branch (no apply happening) still gets approved --
    def test_approve_pending_runs_in_wait_branch(self):
        clock = {'t': datetime(2026, 9, 25, 20, 0, tzinfo=timezone.utc)}
        mod._now_utc = lambda: clock['t']
        def sleep(s):
            clock['t'] += timedelta(seconds=s)
        mod._sleep = sleep
        self.fake = FakeTsenta(now_fn=lambda: clock['t'])
        self.fake.seed_existing_app('pending1', 'PENDING_RESUME_REVIEW', clock['t'] - timedelta(minutes=5))

        result = mod.apply_loop(
            target=1, total_before=1000, today_local=date(2026, 9, 25), tz=TZ,
            run_started_at_utc=(clock['t'] - timedelta(minutes=10)).isoformat().replace('+00:00', 'Z'),
            deadline_utc=clock['t'] + timedelta(minutes=2),
            attempt_cap=10, dry_run=False, pulls=[{}],
            blockers=self.blockers, skipped_reasons=self.skipped_reasons,
        )
        self.assertIn('seed1', self.fake.approve_calls, 'the pending row must be approved from a WAIT branch, not only right after an apply batch')
        self.assertEqual(result['stop_reason'], 'deadline')

    # -- stall fix 2: pool exhausted, gap>0 -> re-source finds a freshly-posted
    # job and it gets applied; bounded refresh count is tracked --
    def test_pool_refresh_finds_new_jobs_and_applies_them(self):
        self.fake.add_job('j0', 'Machine Learning Engineer', 'Co0')
        self.fake.final_status = {'j0': 'COMPLETED', 'j1': 'COMPLETED'}
        self.fake.resolve_ticks = {'j0': 1, 'j1': 1}
        call_count = {'n': 0}
        orig_handle = self.fake.handle
        def handle(tool, args):
            if tool == 'get_job_recommendations':
                call_count['n'] += 1
                if call_count['n'] == 2:
                    self.fake.add_job('j1', 'Machine Learning Engineer', 'Co1')
            return orig_handle(tool, args)
        mod.mcp_call = handle

        result = self.run_loop(target=2, attempt_cap=10)
        self.assertEqual(result['stop_reason'], 'target reached')
        self.assertEqual(result['successes_today'], 2)
        self.assertEqual(result['pool_refreshes'], 1, 'one refresh is all that was needed to discover j1')
        self.assertIn(['j1'], self.fake.apply_calls)

    # -- stall fix 3: pool exhausted, refresh finds nothing new, in-flight frozen
    # -> stop 'in-flight stalled' at ~30 simulated minutes, well before the
    # multi-hour deadline; refreshes stay bounded and >=20 min apart --
    def test_stalled_in_flight_stops_before_deadline(self):
        clock = {'t': datetime(2026, 9, 26, 0, 0, tzinfo=timezone.utc)}
        mod._now_utc = lambda: clock['t']
        def sleep(s):
            clock['t'] += timedelta(seconds=s)
        mod._sleep = sleep
        self.fake = FakeTsenta(now_fn=lambda: clock['t'])
        self.fake.add_job('j0', 'Machine Learning Engineer', 'Co0')
        self.fake.resolve_ticks = {'j0': 999}  # never resolves within the test

        run_started = clock['t'].isoformat().replace('+00:00', 'Z')
        result = mod.apply_loop(
            target=2, total_before=1000, today_local=date(2026, 9, 26), tz=TZ,
            run_started_at_utc=run_started,
            deadline_utc=clock['t'] + timedelta(hours=5),
            attempt_cap=10, dry_run=False, pulls=[{}],
            blockers=self.blockers, skipped_reasons=self.skipped_reasons,
        )
        self.assertEqual(result['stop_reason'], 'in-flight stalled')
        self.assertLessEqual(result['pool_refreshes'], 3)
        self.assertLess(clock['t'], datetime(2026, 9, 26, 1, 0, tzinfo=timezone.utc),
                         'must stop at the ~30min stall, well before the 5-hour deadline')

    # -- still-changing in-flight (a job leaves, another keeps ticking) spans
    # more than 30 minutes total but never sits static for 30 min -> no stall --
    def test_in_flight_still_changing_no_stall(self):
        clock = {'t': datetime(2026, 9, 26, 0, 0, tzinfo=timezone.utc)}
        mod._now_utc = lambda: clock['t']
        def sleep(s):
            clock['t'] += timedelta(seconds=s)
        mod._sleep = sleep
        self.fake = FakeTsenta(now_fn=lambda: clock['t'])
        self.fake.add_job('j0', 'Machine Learning Engineer', 'Co0')
        self.fake.add_job('j1', 'Machine Learning Engineer', 'Co1')
        self.fake.final_status = {'j0': 'COMPLETED', 'j1': 'COMPLETED'}
        self.fake.resolve_ticks = {'j0': 10, 'j1': 35}

        run_started = clock['t'].isoformat().replace('+00:00', 'Z')
        result = mod.apply_loop(
            target=2, total_before=1000, today_local=date(2026, 9, 26), tz=TZ,
            run_started_at_utc=run_started,
            deadline_utc=clock['t'] + timedelta(hours=5),
            attempt_cap=10, dry_run=False, pulls=[{}],
            blockers=self.blockers, skipped_reasons=self.skipped_reasons,
        )
        self.assertEqual(result['stop_reason'], 'target reached')
        self.assertEqual(result['successes_today'], 2)

    # -- filter gaps a/b/c: bare clearance/federal text, new blocked companies,
    # a profile.yml blocklist entry, and level 4+ titles --
    def test_expanded_filters_block_new_gaps(self):
        def mk(id_, title, company='Acme'):
            return {'id': id_, 'title': title, 'companyName': company,
                    'isSupportedAts': True, 'employmentType': 'FULL_TIME'}
        candidates = [
            mk('dod', 'Machine Learning Engineer - DoD Security Clearance'),
            mk('asrc', 'Machine Learning Engineer', company='ASRC Federal'),
            mk('draper', 'Machine Learning Engineer', company='<TARGET_COMPANY>'),
            mk('guidehouse', 'Machine Learning Engineer', company='Guidehouse Public Sector'),
            mk('mantech', 'Machine Learning Engineer', company='ManTech International'),
            mk('lvl4', 'Machine Learning Engineer 4'),
            mk('lvl_iv', 'Software Engineer IV'),
            mk('lvl2', 'Software Engineer II'),
            mk('lvl3', 'Machine Learning Engineer III'),
            mk('usfed', 'Software Development Engineer - ML Ops (US Federal)'),
        ]
        skips = Counter()
        eligible = mod.filter_candidates(candidates, {}, set(), skips)
        ids = {j['id'] for j in eligible}
        for blocked in ('dod', 'asrc', 'draper', 'guidehouse', 'mantech', 'lvl4', 'lvl_iv', 'usfed'):
            self.assertNotIn(blocked, ids, f'{blocked} must be blocked')
        for allowed in ('lvl2', 'lvl3'):
            self.assertIn(allowed, ids, f'{allowed} must be allowed')
        self.assertFalse(mod.BAD_LEVEL.search('Web3 Engineer'), 'Web3 must not be treated as a level 4+ role')

    # -- review finding: the bare clearance/public-trust patterns above have no
    # negation guard, so a JD reassuring OPT candidates ("no clearance required")
    # was hard-skipped as if it demanded one -- the opposite of its real meaning --
    def test_negated_clearance_phrases_do_not_block(self):
        def mk(id_):
            return {'id': id_, 'title': 'Machine Learning Engineer', 'companyName': 'Acme',
                    'isSupportedAts': True, 'employmentType': 'FULL_TIME'}
        candidates = [mk('neg1'), mk('neg2'), mk('neg3')]
        details = {
            'neg1': {'description': 'No security clearance required for this role.'},
            'neg2': {'description': 'No clearance required; open to all candidates.'},
            'neg3': {'description': 'This role does not require a security clearance.'},
        }
        skips = Counter()
        eligible = mod.filter_candidates(candidates, details, set(), skips)
        ids = {j['id'] for j in eligible}
        for allowed in ('neg1', 'neg2', 'neg3'):
            self.assertIn(allowed, ids, f'{allowed}: negated clearance mention must not be skipped')
        # a real, unnegated bare mention must still be blocked
        self.assertTrue(mod._has_bare_clearance_risk('Machine Learning Engineer - DoD Security Clearance'))

    # -- workday deprioritization: stable-sort moves workday/smartrecruiters
    # after everything else, preserving order otherwise --
    def test_ats_deprioritization_sorts_workday_smartrecruiters_last(self):
        jobs = [
            {'id': 'a', 'atsType': 'greenhouse', 'matchScore': 3},
            {'id': 'b', 'atsType': 'workday', 'matchScore': 9},
            {'id': 'c', 'atsType': 'lever', 'matchScore': 2},
            {'id': 'd', 'atsType': 'smartrecruiters', 'matchScore': 8},
            {'id': 'e', 'atsType': 'ashby', 'matchScore': 1},
        ]
        jobs.sort(key=mod._ats_sort_key)
        self.assertEqual([j['id'] for j in jobs], ['a', 'c', 'e', 'b', 'd'],
                          'workday/smartrecruiters moved after others, order otherwise preserved')


class DayTargetStampTestCase(unittest.TestCase):
    def setUp(self):
        self._orig_now = mod._now_utc
        mod._now_utc = lambda: datetime(2026, 9, 25, 3, 0, tzinfo=timezone.utc)

    def tearDown(self):
        mod._now_utc = self._orig_now

    def test_persists_and_reuses_same_day_target(self):
        with tempfile.TemporaryDirectory() as td:
            stamp_dir = Path(td)
            calls = {'n': 0}

            def compute_v1():
                calls['n'] += 1
                return {'target': 74, 'days_left': 20}

            data1, path1, reused1 = mod.load_or_compute_day_target(date(2026, 9, 25), compute_v1, stamp_dir=stamp_dir)
            self.assertFalse(reused1)
            self.assertEqual(data1['target'], 74)
            self.assertEqual(calls['n'], 1)

            def compute_v2():
                calls['n'] += 1
                return {'target': 999, 'days_left': 1}  # would be wrong if recomputed

            data2, path2, reused2 = mod.load_or_compute_day_target(date(2026, 9, 25), compute_v2, stamp_dir=stamp_dir)
            self.assertTrue(reused2)
            self.assertEqual(data2['target'], 74, 'later same-day run must reuse the persisted target, not recompute')
            self.assertEqual(calls['n'], 1, 'compute_fn must not be called again on reuse')

    def test_different_day_recomputes(self):
        with tempfile.TemporaryDirectory() as td:
            stamp_dir = Path(td)
            mod.load_or_compute_day_target(date(2026, 9, 25), lambda: {'target': 74}, stamp_dir=stamp_dir)
            data2, _, reused2 = mod.load_or_compute_day_target(date(2026, 9, 26), lambda: {'target': 80}, stamp_dir=stamp_dir)
            self.assertFalse(reused2)
            self.assertEqual(data2['target'], 80)


class DeadlineTestCase(unittest.TestCase):
    def test_default_next_0530_local(self):
        tz = TZ
        run_started_local = datetime(2026, 9, 25, 22, 0, tzinfo=tz)  # 10pm run
        deadline = mod.compute_deadline_utc(run_started_local, tz, env_val='')
        deadline_local = deadline.astimezone(tz)
        self.assertEqual(deadline_local.date(), date(2026, 9, 26))
        self.assertEqual((deadline_local.hour, deadline_local.minute), (5, 30))

    def test_hhmm_env_next_occurrence(self):
        tz = TZ
        run_started_local = datetime(2026, 9, 25, 6, 0, tzinfo=tz)
        deadline = mod.compute_deadline_utc(run_started_local, tz, env_val='05:30')
        deadline_local = deadline.astimezone(tz)
        self.assertEqual(deadline_local.date(), date(2026, 9, 26))


class ReportPathTestCase(unittest.TestCase):
    # -- review fix: a same-day dry-run preview must never overwrite a
    # completed real run's report --
    def test_dryrun_report_path_is_distinct_from_real_report_path(self):
        self.assertNotEqual(mod.DRYRUN_REPORT_MD, mod.REPORT_MD)
        self.assertTrue(str(mod.DRYRUN_REPORT_MD).endswith('-dryrun.md'))


if __name__ == '__main__':
    unittest.main()


class ListAppsSinceCutoffTest(unittest.TestCase):
    """list_apps(since_dt=...) must stop paginating once a newest-first page reaches older rows."""

    def test_stops_after_cutoff_page(self):
        base = datetime(2026, 9, 25, 12, 0, tzinfo=timezone.utc)
        rows = [{'applicationId': f'a{i}', 'createdAt': (base - timedelta(hours=i)).isoformat()} for i in range(350)]
        calls = []

        def fake(tool, args):
            calls.append(args['page'])
            start = (args['page'] - 1) * args['limit']
            return {'applications': rows[start:start + args['limit']],
                    'pagination': {'page': args['page'], 'limit': args['limit'], 'total': len(rows), 'totalPages': 4}}

        orig = mod.mcp_call
        mod.mcp_call = fake
        try:
            got = mod.list_apps(100, all_pages=True, since_dt=base - timedelta(hours=150))
            self.assertEqual(calls, [1, 2])          # page 2 reaches rows older than the cutoff -> stop
            self.assertTrue(all(any(a['applicationId'] == r['applicationId'] for a in mod.normalize_apps(got)) for r in rows[:151]))
            calls.clear()
            mod.list_apps(100, all_pages=True)       # no cutoff -> full history, unchanged behaviour
            self.assertEqual(calls, [1, 2, 3, 4])
        finally:
            mod.mcp_call = orig


class SharedInviteAllowanceTest(unittest.TestCase):
    def _run(self, stdout=None, exc=None):
        import subprocess as sp
        orig = mod.subprocess.run
        def fake(*a, **k):
            if exc: raise exc
            return sp.CompletedProcess(a, 0, stdout=stdout, stderr='')
        mod.subprocess.run = fake
        try:
            return mod.shared_invite_allowance()
        finally:
            mod.subprocess.run = orig

    def test_takes_the_smallest_of_cap_today_and_week(self):
        self.assertEqual(self._run('{"available":true,"remainingToday":30,"remainingThisWeek":12}\n'), 12)
        self.assertEqual(self._run('{"available":true,"remainingToday":7,"remainingThisWeek":76}\n'), 7)
        self.assertEqual(self._run('{"available":true,"remainingToday":99,"remainingThisWeek":99}\n'), 35)

    def test_exhausted_budget_is_zero(self):
        self.assertEqual(self._run('{"available":true,"remainingToday":0,"remainingThisWeek":40}\n'), 0)

    def test_unreadable_budget_falls_back_small(self):
        self.assertEqual(self._run(exc=OSError('node missing')), 10)
        self.assertEqual(self._run('not json\n'), 10)
