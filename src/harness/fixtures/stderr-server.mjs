// Dies during startup after complaining on stderr, the shape of a server with
// a missing dependency. Sets exitCode instead of exiting so stderr flushes.
process.stderr.write('stderr-server: fatal: cannot find module "definitely-not-installed"\n');
process.stderr.write('stderr-server: giving up\n');
process.exitCode = 1;
