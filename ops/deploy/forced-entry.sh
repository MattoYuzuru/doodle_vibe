#!/bin/sh
# SSH always executes this root-owned entry point; no user-controlled shell eval.
exec sudo -n /usr/local/sbin/doodle-deploy "${SSH_ORIGINAL_COMMAND-}"
