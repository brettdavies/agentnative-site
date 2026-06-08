# The agent-native CLI standard

CLI tools are how AI agents touch everything else. Compilers, databases, git, the cloud, the shell. An agent asked to
ship code, rotate a credential, grep a log, or deploy a branch frequently shells out to a binary. It's the
lowest-common-denominator interface where APIs don't exist or don't compose. The agent reads the output, decides what
went right or wrong, and picks the next move. There is no human between the request and the process. The CLI either
makes that loop tractable or it does not.
