-- Runs once, on first initialization of the Postgres data volume.
--
-- The test suite TRUNCATEs between cases, so it must never point at the
-- database holding real annotations. A separate database makes that a
-- configuration fact rather than a rule someone has to remember.
CREATE DATABASE adg_test;
