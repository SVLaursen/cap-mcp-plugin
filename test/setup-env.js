// Tests deliberately trigger CAP errors (403, 409, …). Keep the expected ones out of the output.
process.env.CDS_LOG_LEVELS_ODATA ??= "error";
process.env.CDS_LOG_LEVELS_CDS ??= "warn";
