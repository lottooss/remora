@AGENTS.md

## Claude Code specifics

- `AGENTS.md` (imported above) is the operating manual; this file only adds Claude-specific habits.
- Use plan mode before L-size task packets; put the plan in the PR description.
- Keep scratch files in `.scratch/` (git-ignored). Never write outside the repository except the isolated temporary `DSH_HOME` used by tests.
- Before finishing a task, run the packet's *Verify* commands and the §8 gates for every area you touched, and paste real results into the handoff report.
