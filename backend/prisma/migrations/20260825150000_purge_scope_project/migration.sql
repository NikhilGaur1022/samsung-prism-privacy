-- A project-scoped erasure: everything one withdrawn consent authorised, and
-- nothing held per-subject. Added because a §6(4) withdrawal from a single
-- project was being executed as a whole-subject purge — destroying the
-- principal's data in every other project, crypto-shredding the per-subject DEK
-- and anonymising the identity row, in response to a request that asked for
-- none of it.
ALTER TYPE "PurgeJobScope" ADD VALUE IF NOT EXISTS 'PROJECT';
