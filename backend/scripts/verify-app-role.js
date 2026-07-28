#!/usr/bin/env node
/**
 * Prove that the connected database role cannot edit the evidentiary tables.
 *
 *   node scripts/verify-app-role.js
 *
 * Run this after scripts/sql/provision-app-role.sql and after repointing
 * DATABASE_URL at prism_app. It is the check behind the claim "the compliance
 * ledger cannot be edited", and it is written as a check rather than a comment
 * because the claim was false for the whole of this project's life until the
 * role existed: Supabase's `postgres` holds BYPASSRLS, which skips RLS
 * unconditionally, FORCE included.
 *
 * Every write below is a no-op by construction (WHERE false). What is being
 * tested is whether the privilege check fires at all — a permitted no-op still
 * returns success, so a success here is a real failure.
 *
 * Exits non-zero if any of them is permitted.
 */
import { PrismaClient } from '@prisma/client';

const EVIDENTIARY = [
  ['UPDATE audit_log', "UPDATE audit_log SET action = 'verify-app-role' WHERE false"],
  ['DELETE audit_log', 'DELETE FROM audit_log WHERE false'],
  ['DELETE access_events', 'DELETE FROM access_events WHERE false'],
  ['UPDATE access_events', "UPDATE access_events SET purpose = 'verify-app-role' WHERE false"],
  ['DELETE deletion_certificates', 'DELETE FROM deletion_certificates WHERE false'],
];

const prisma = new PrismaClient();
let failures = 0;

function report(ok, label, detail) {
  if (!ok) failures += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`);
}

try {
  const [role] = await prisma.$queryRawUnsafe(
    'SELECT current_user AS "user", rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user',
  );
  console.log(`connected as ${role.user}\n`);

  report(!role.rolsuper, 'rolsuper is false', role.rolsuper ? 'role is a SUPERUSER' : null);
  report(
    !role.rolbypassrls,
    'rolbypassrls is false',
    role.rolbypassrls ? 'role skips RLS unconditionally — FORCE included' : null,
  );

  for (const [label, sql] of EVIDENTIARY) {
    let outcome = 'permitted';
    let why = 'PERMITTED — the ledger is mutable';
    try {
      await prisma.$executeRawUnsafe(sql);
    } catch (err) {
      const flat = err.message.replace(/\s+/g, ' ');
      const at = flat.indexOf('ERROR:');
      why = (at === -1 ? flat : flat.slice(at)).slice(0, 100);
      // Insisting on 42501 specifically, because any other error is the
      // statement failing to reach the privilege check at all. A typo'd column
      // raises 42703 and would otherwise be scored as "denied" — a check that
      // accepts any error passes just as happily against no protection.
      outcome = /42501|permission denied/i.test(flat) ? 'denied' : 'inconclusive';
    }
    report(
      outcome === 'denied',
      `${label} denied`,
      outcome === 'inconclusive' ? `INCONCLUSIVE, not a privilege error — ${why}` : why,
    );
  }

  // The application legitimately deletes from ordinary tables; erasure is the
  // product. A role locked down so hard it cannot do that is also wrong.
  try {
    await prisma.$executeRawUnsafe('DELETE FROM photo_subjects WHERE false');
    report(true, 'DELETE photo_subjects permitted', 'ordinary DML still works');
  } catch (err) {
    report(false, 'DELETE photo_subjects permitted', err.message.replace(/\s+/g, ' ').slice(0, 100));
  }
} finally {
  await prisma.$disconnect();
}

console.log(failures === 0 ? '\nall checks passed' : `\n${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
