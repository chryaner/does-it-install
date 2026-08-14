// Writes a banner to stdout instead of JSON-RPC and exits: the classic
// "my server prints to stdout" failure. Exits naturally so both pipes flush.
process.stdout.write('Welcome to garbage-server! Listening on stdio.\n');
process.stderr.write('garbage-server: printed a banner on stdout instead of speaking MCP\n');
