#!/usr/bin/env python3
"""P1-A capacity cleanup — ficwb only. Run once with approval."""
from __future__ import annotations

import csv
import os
import sys
from datetime import datetime, timezone
from pathlib import Path

import psycopg2

ROLLBACK_DIR = Path(__file__).resolve().parent / "rollback" / "p1a_capacity_20260603"
EXPECTED_NULL_CYCLUS = 275
DUPLICATE_CANCEL_ID = "f5ab8a94-95a6-45d3-af6c-68952f17056c"
DUPLICATE_KEEP_ID = "0691fa92-6078-46b2-9145-6f268d3fcbcb"
INVOICE_ID = "b74eaa7e-de6d-476d-950f-2a2c97b909ce"
SLOT_ID = "c54dff64-d145-49c7-98d5-7f96a167f4f3"
GUEST_ID = "44258428-d73d-4282-93e4-9cc0ab992340"


def get_conn():
    db = os.environ.get("DATABASE_URL")
    if not db:
        print("DATABASE_URL not set", file=sys.stderr)
        sys.exit(1)
    if "ficwbdrzefmblkbkomzw" not in db:
        print("Refusing: DATABASE_URL does not look like ficwb", file=sys.stderr)
        sys.exit(1)
    return psycopg2.connect(db)


def export_rollback(cur) -> None:
    ROLLBACK_DIR.mkdir(parents=True, exist_ok=True)

    cur.execute(
        """
        SELECT id, max_participants, cyclus_id, cyclus_name, start_time, created_at
        FROM public.availability_slots
        WHERE max_participants IS NULL AND cyclus_id IS NOT NULL
        ORDER BY id
        """
    )
    cols = [d[0] for d in cur.description]
    rows = cur.fetchall()
    path = ROLLBACK_DIR / "availability_slots_before.csv"
    with path.open("w", newline="") as f:
        w = csv.writer(f)
        w.writerow(cols)
        w.writerows(rows)
    print(f"Exported {len(rows)} slots -> {path}")

    cur.execute(
        """
        SELECT id, slot_id, guest_player_id, player_id, status, payment_status,
               created_at, updated_at
        FROM public.bookings
        WHERE id IN (%s, %s)
        """,
        (DUPLICATE_KEEP_ID, DUPLICATE_CANCEL_ID),
    )
    cols = [d[0] for d in cur.description]
    rows = cur.fetchall()
    path = ROLLBACK_DIR / "bookings_before.csv"
    with path.open("w", newline="") as f:
        w = csv.writer(f)
        w.writerow(cols)
        w.writerows(rows)
    print(f"Exported {len(rows)} bookings -> {path}")

    cur.execute(
        """
        SELECT id, invoice_number, status, total, subtotal, vat_amount,
               line_items::text, booking_ids::text, updated_at
        FROM public.invoices
        WHERE id = %s
        """,
        (INVOICE_ID,),
    )
    cols = [d[0] for d in cur.description]
    rows = cur.fetchall()
    path = ROLLBACK_DIR / "invoice_before.csv"
    with path.open("w", newline="") as f:
        w = csv.writer(f)
        w.writerow(cols)
        w.writerows(rows)
    print(f"Exported invoice -> {path}")

    meta = ROLLBACK_DIR / "README.txt"
    meta.write_text(
        f"P1-A rollback snapshot\nUTC: {datetime.now(timezone.utc).isoformat()}\n"
        f"Expected backfill rows: {EXPECTED_NULL_CYCLUS}\n",
        encoding="utf-8",
    )


def verify_counts(cur) -> dict:
    cur.execute(
        """
        SELECT COUNT(*) FROM public.availability_slots
        WHERE max_participants IS NULL AND cyclus_id IS NOT NULL
        """
    )
    null_cyclus = cur.fetchone()[0]

    cur.execute(
        """
        SELECT COUNT(*) FROM public.bookings
        WHERE id = %s AND status = 'confirmed'
          AND slot_id = %s AND guest_player_id = %s
        """,
        (DUPLICATE_CANCEL_ID, SLOT_ID, GUEST_ID),
    )
    dup_ready = cur.fetchone()[0]

    cur.execute(
        """
        SELECT COUNT(*) FROM public.invoices
        WHERE id = %s AND booking_ids @> ARRAY[%s::uuid]
        """,
        (INVOICE_ID, DUPLICATE_CANCEL_ID),
    )
    inv_has_dup = cur.fetchone()[0]

    return {
        "null_cyclus": null_cyclus,
        "dup_ready": dup_ready,
        "inv_has_dup": inv_has_dup,
    }


def run_cleanup(cur) -> dict:
    pre = verify_counts(cur)
    if pre["null_cyclus"] != EXPECTED_NULL_CYCLUS:
        raise RuntimeError(
            f"Pre-check: expected {EXPECTED_NULL_CYCLUS} null cyclus slots, got {pre['null_cyclus']}"
        )
    if pre["dup_ready"] != 1:
        raise RuntimeError(f"Pre-check: duplicate booking not ready to cancel (count={pre['dup_ready']})")
    if pre["inv_has_dup"] != 1:
        raise RuntimeError(f"Pre-check: invoice missing duplicate booking id (count={pre['inv_has_dup']})")

    cur.execute("BEGIN")

    cur.execute(
        """
        UPDATE public.availability_slots
        SET max_participants = 4
        WHERE max_participants IS NULL AND cyclus_id IS NOT NULL
        """
    )
    slots_updated = cur.rowcount

    cur.execute(
        """
        UPDATE public.bookings
        SET status = 'cancelled', updated_at = now()
        WHERE id = %s::uuid
          AND slot_id = %s::uuid
          AND guest_player_id = %s::uuid
          AND status = 'confirmed'
        """,
        (DUPLICATE_CANCEL_ID, SLOT_ID, GUEST_ID),
    )
    bookings_cancelled = cur.rowcount

    cur.execute(
        """
        UPDATE public.invoices
        SET booking_ids = array_remove(booking_ids, %s::uuid),
            updated_at = now()
        WHERE id = %s::uuid
          AND booking_ids @> ARRAY[%s::uuid]
        """,
        (DUPLICATE_CANCEL_ID, INVOICE_ID, DUPLICATE_CANCEL_ID),
    )
    invoices_updated = cur.rowcount

    if slots_updated != EXPECTED_NULL_CYCLUS:
        cur.execute("ROLLBACK")
        raise RuntimeError(f"UPDATE slots: expected {EXPECTED_NULL_CYCLUS}, got {slots_updated}")
    if bookings_cancelled != 1:
        cur.execute("ROLLBACK")
        raise RuntimeError(f"UPDATE booking cancel: expected 1, got {bookings_cancelled}")
    if invoices_updated != 1:
        cur.execute("ROLLBACK")
        raise RuntimeError(f"UPDATE invoice: expected 1, got {invoices_updated}")

    cur.execute(
        """
        SELECT COUNT(*) FROM public.availability_slots
        WHERE max_participants IS NULL AND cyclus_id IS NOT NULL
        """
    )
    remaining_null = cur.fetchone()[0]
    if remaining_null != 0:
        cur.execute("ROLLBACK")
        raise RuntimeError(f"Post-check: {remaining_null} null cyclus slots remain")

    cur.execute(
        """
        SELECT COUNT(*) FROM (
          SELECT b.slot_id, COALESCE(b.player_id, b.guest_player_id) AS pid
          FROM public.bookings b
          WHERE b.status NOT IN ('cancelled', 'canceled')
            AND COALESCE(b.player_id, b.guest_player_id) IS NOT NULL
          GROUP BY b.slot_id, COALESCE(b.player_id, b.guest_player_id)
          HAVING COUNT(*) > 1
        ) d
        """
    )
    dup_remaining = cur.fetchone()[0]
    if dup_remaining != 0:
        cur.execute("ROLLBACK")
        raise RuntimeError(f"Post-check: {dup_remaining} duplicate player/slot groups remain")

    cur.execute(
        """
        SELECT total, status, line_items::text, subtotal, vat_amount
        FROM public.invoices WHERE id = %s
        """,
        (INVOICE_ID,),
    )
    inv_after = cur.fetchone()

    cur.execute(
        """
        SELECT payment_status FROM public.bookings WHERE id = %s
        """,
        (DUPLICATE_CANCEL_ID,),
    )
    cancelled_payment_status = cur.fetchone()[0]

    cur.execute("COMMIT")

    return {
        "slots_updated": slots_updated,
        "bookings_cancelled": bookings_cancelled,
        "invoices_updated": invoices_updated,
        "remaining_null": remaining_null,
        "dup_remaining": dup_remaining,
        "invoice_total": inv_after[0] if inv_after else None,
        "invoice_status": inv_after[1] if inv_after else None,
        "invoice_line_items_unchanged": True,  # validated below via export
        "cancelled_booking_payment_status": cancelled_payment_status,
    }


def post_verify(cur) -> dict:
    checks = {}
    cur.execute(
        """
        SELECT COUNT(*) FROM (
          SELECT s.id FROM public.availability_slots s
          JOIN public.bookings b ON b.slot_id = s.id
            AND b.status NOT IN ('cancelled', 'canceled')
          GROUP BY s.id, s.max_participants
          HAVING COUNT(*) > COALESCE(NULLIF(s.max_participants, 0), 4)
        ) o
        """
    )
    checks["slot_overbooked_new"] = cur.fetchone()[0]

    cur.execute(
        """
        SELECT COUNT(*) FROM (
          SELECT s.id FROM public.availability_slots s
          JOIN public.bookings b ON b.slot_id = s.id
            AND b.status NOT IN ('cancelled', 'canceled')
          GROUP BY s.id, s.max_participants
          HAVING COUNT(*) > COALESCE(NULLIF(s.max_participants, 0), 1)
        ) o
        """
    )
    checks["slot_overbooked_legacy"] = cur.fetchone()[0]

    cur.execute(
        """
        SELECT COUNT(*) FROM (
          SELECT b.slot_id, COALESCE(b.player_id, b.guest_player_id) AS pid
          FROM public.bookings b
          WHERE b.status NOT IN ('cancelled', 'canceled')
            AND COALESCE(b.player_id, b.guest_player_id) IS NOT NULL
          GROUP BY b.slot_id, COALESCE(b.player_id, b.guest_player_id)
          HAVING COUNT(*) > 1
        ) d
        """
    )
    checks["duplicate_player_slot"] = cur.fetchone()[0]

    cur.execute(
        "SELECT COUNT(*) FROM public.availability_slots WHERE max_participants IS NULL AND cyclus_id IS NOT NULL"
    )
    checks["cyclus_null_max"] = cur.fetchone()[0]

    cur.execute(
        "SELECT cardinality(booking_ids) FROM public.invoices WHERE id = %s",
        (INVOICE_ID,),
    )
    checks["invoice_booking_ids_count"] = cur.fetchone()[0]

    return checks


def load_invoice_snapshot() -> tuple:
    import csv as csvmod

    path = ROLLBACK_DIR / "invoice_before.csv"
    with path.open() as f:
        row = next(csvmod.DictReader(f))
    return (
        row["total"],
        row["status"],
        row["line_items"],
        row.get("subtotal"),
        row.get("vat_amount"),
    )


def main() -> None:
    conn = get_conn()
    try:
        conn.autocommit = False
        with conn.cursor() as cur:
            print("=== Phase 0: Export rollback ===")
            export_rollback(cur)
            conn.commit()
            inv_before = load_invoice_snapshot()

            print("\n=== Phase 1: Execute cleanup (transaction) ===")
            result = run_cleanup(cur)
            for k, v in result.items():
                print(f"  {k}: {v}")

            with conn.cursor() as cur2:
                cur2.execute(
                    """
                    SELECT total::text, status, line_items::text, subtotal::text, vat_amount::text
                    FROM public.invoices WHERE id = %s
                    """,
                    (INVOICE_ID,),
                )
                inv_now = cur2.fetchone()
            if inv_now[0] != inv_before[0] or inv_now[1] != inv_before[1] or inv_now[2] != inv_before[2]:
                print("INVOICE FINANCIAL FIELDS CHANGED — investigate", file=sys.stderr)
                print(f"  before total/status: {inv_before[0]}, {inv_before[1]}", file=sys.stderr)
                print(f"  after: {inv_now}", file=sys.stderr)
                sys.exit(1)
            if result.get("cancelled_booking_payment_status") != "paid":
                print(
                    f"WARNING: cancelled booking payment_status={result.get('cancelled_booking_payment_status')} (expected paid unchanged)",
                    file=sys.stderr,
                )
            print("  invoice_total_status_line_items: unchanged (verified)")

            print("\n=== Phase 2: Post verification ===")
            post = post_verify(cur)
            for k, v in post.items():
                print(f"  {k}: {v}")

            expected = {
                "slot_overbooked_new": 0,
                "slot_overbooked_legacy": 0,
                "duplicate_player_slot": 0,
                "cyclus_null_max": 0,
            }
            failed = [k for k, exp in expected.items() if post.get(k) != exp]
            if failed:
                print(f"VERIFICATION FAILED: {failed}", file=sys.stderr)
                sys.exit(1)
            print("\nSUCCESS: all verification checks passed")
    finally:
        conn.close()


if __name__ == "__main__":
    main()
