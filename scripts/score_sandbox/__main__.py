import sys

sys.dont_write_bytecode = True

from .run import main  # noqa: E402

raise SystemExit(main())
