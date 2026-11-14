# Upgrading to 1.0.0-beta.1

1.0.0-beta.1 freezes the wire format, so the breaking changes still owed land in it. Each section below says what changed, how to tell whether you are affected, and what to do.

## Date values must be instants

**What changed.** A `date` field value sent through a mutation, and a filter operand on a `date` field (including `createdAt` and `updatedAt`), must be an ISO 8601 instant: a date, a time and an offset, such as `2026-11-14T10:00:00Z` or `2026-11-14T10:00:00+01:00`. A date alone (`2026-11-14`), a date with an offset but no time (`2026-11-14Z`) and a date-time with no offset (`2026-11-14T10:00:00`) are refused. Before, they were accepted and read as UTC, so a caller in another zone silently got the wrong instant.

- A write is refused with `invalid_field_type`: `Cannot create 'dueAt' with "2026-11-14T10:00:00": expected an ISO 8601 instant with a time and an offset, e.g. 2026-11-14T10:00:00Z or 2026-11-14T10:00:00+01:00.`
- A filter operand is refused with `type_mismatch`, naming the field and the same accepted form.

**Are you affected?** You are if any client writes or filters dates as bare days or local date-times. Search your code for date strings without a trailing `Z` or `±HH:MM`, and for `toISOString().slice(0, 10)`. A refused request names the field, so a failing write or read points at the call. Rows already stored with an offset-less date are not affected: they still read, as UTC.

**What to do.** Send a full instant. In JavaScript, `new Date(...).toISOString()` always produces one. For a whole day, send its midnight in the zone you mean: `where: { at: { gte: '2026-11-14T00:00:00+01:00', lt: '2026-11-15T00:00:00+01:00' } }`.

## `_allowTableScan` is refused

**What changed.** The `_allowTableScan` param was accepted and ignored since filters stopped being refused for want of an index. It is now an unknown param: a query on an autoCRUD list, a subscribe and a stream that send it are refused with `unknown_param`, and the message lists the params that are allowed.

**Are you affected?** You are if any client, script or saved frame sends `_allowTableScan`. Search for the string.

**What to do.** Delete it. It changed nothing, so removing it changes no result.

## `SUBSTRATE_PARTITION_BUDGET` is now `SUBSTRATE_TYPE_TABLE_BUDGET`

**What changed.** The env var that sets how many type tables the storage report allows before it warns is renamed `SUBSTRATE_TYPE_TABLE_BUDGET`, since it counts type tables, not partitions. The old name is still read while the new one is unset, and logs one deprecation warning at boot. It will be removed in a later release.

**Are you affected?** You are if a unit file, compose file or environment sets `SUBSTRATE_PARTITION_BUDGET`, or if the boot log shows `warning: SUBSTRATE_PARTITION_BUDGET is deprecated`.

**What to do.** Rename the variable. When both are set, `SUBSTRATE_TYPE_TABLE_BUDGET` wins.
