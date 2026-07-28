#!/usr/bin/env node
/**
 * Run a .sql file against DIRECT_URL without needing psql on PATH.
 *
 * psql is not installed on every machine that has to provision this database
 * (Windows dev boxes, in particular), and the Supabase MCP server needs an
 * access token that is not always present. This runs the same file through the
 * Prisma client the application already depends on.
 *
 *   node scripts/run-sql.js scripts/sql/provision-app-role.sql -v password="'s3cret'"
 *
 * It understands the small slice of psql syntax the .sql files in this repo use:
 *
 *   \set NAME value      parsed and ignored (ON_ERROR_STOP is implicit here —
 *                        the whole file runs in one transaction and any error
 *                        aborts it)
 *   :'name'              substituted from -v, quoted exactly as given
 *
 * Everything between BEGIN and COMMIT is sent as one Prisma interactive
 * transaction, so a failure half way through leaves the database untouched.
 * Statements are split on semicolons outside dollar-quoted blocks, so DO $$ ...
 * $$ bodies survive intact.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
import { PrismaClient } from '@prisma/client';

const here = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(here, '..', '.env') });

function parseArgs(argv) {
  const vars = {};
  let file = null;
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '-v' || argv[i] === '--set') {
      const assignment = argv[i + 1];
      i += 1;
      if (!assignment || !assignment.includes('=')) {
        throw new Error(`-v expects name=value, got: ${assignment}`);
      }
      const eq = assignment.indexOf('=');
      vars[assignment.slice(0, eq)] = assignment.slice(eq + 1);
    } else if (!file) {
      file = argv[i];
    } else {
      throw new Error(`unexpected argument: ${argv[i]}`);
    }
  }
  if (!file) throw new Error('usage: run-sql.js <file.sql> [-v name=value ...]');
  return { file, vars };
}

/** Strip comments and psql backslash directives; substitute :'name' variables. */
function preprocess(sql, vars) {
  const lines = sql.split(/\r?\n/).filter((line) => {
    const t = line.trim();
    return !t.startsWith('\\') && !t.startsWith('--');
  });

  return lines.join('\n').replace(/:'([A-Za-z_][A-Za-z0-9_]*)'/g, (_, name) => {
    if (!(name in vars)) throw new Error(`unset variable :'${name}' — pass -v ${name}=...`);
    return vars[name];
  });
}

/** Split on semicolons that are not inside a dollar-quoted block or a string. */
function splitStatements(sql) {
  const statements = [];
  let current = '';
  let i = 0;
  let tag = null;

  while (i < sql.length) {
    if (tag) {
      if (sql.startsWith(tag, i)) {
        current += tag;
        i += tag.length;
        tag = null;
        continue;
      }
    } else {
      const open = /^\$[A-Za-z_0-9]*\$/.exec(sql.slice(i));
      if (open) {
        tag = open[0];
        current += tag;
        i += tag.length;
        continue;
      }
      if (sql[i] === "'") {
        const end = sql.indexOf("'", i + 1);
        const stop = end === -1 ? sql.length : end + 1;
        current += sql.slice(i, stop);
        i = stop;
        continue;
      }
      if (sql[i] === ';') {
        if (current.trim()) statements.push(current.trim());
        current = '';
        i += 1;
        continue;
      }
    }
    current += sql[i];
    i += 1;
  }

  if (current.trim()) statements.push(current.trim());
  return statements;
}

async function main() {
  const { file, vars } = parseArgs(process.argv.slice(2));
  const raw = fs.readFileSync(path.resolve(file), 'utf8');
  const statements = splitStatements(preprocess(raw, vars))
    // BEGIN/COMMIT are the file's own transaction markers; the runner supplies
    // the transaction itself, and Prisma rejects them inside one.
    .filter((s) => !/^(BEGIN|COMMIT|END)$/i.test(s));

  const prisma = new PrismaClient();
  try {
    await prisma.$transaction(
      async (tx) => {
        for (const statement of statements) {
          const label = statement.replace(/\s+/g, ' ').slice(0, 72);
          process.stdout.write(`  ${label}${statement.length > 72 ? '…' : ''}\n`);
          await tx.$executeRawUnsafe(statement);
        }
      },
      // Provisioning talks to a remote Postgres a statement at a time, and
      // GRANT ... ON ALL TABLES is not fast. Prisma's 5s default expires the
      // transaction mid-file and rolls back work that had all succeeded.
      { timeout: 120_000, maxWait: 30_000 },
    );
    console.log(`\n${statements.length} statements applied from ${file}`);
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err) => {
  console.error(`\nFAILED: ${err.message.split('\n').slice(-6).join('\n')}`);
  process.exit(1);
});
