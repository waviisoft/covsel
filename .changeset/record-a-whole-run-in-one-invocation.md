---
'@covsel/core': minor
'@covsel/conformance': minor
---

A recorder can now record the whole suite in one invocation, returning a unit per
test, by implementing `recordRun(testFiles)` instead of `record(testFile)`.
Recording reconciles what comes back against the files it asked for, so a test
file the run never reported fails the recording rather than being written as
silence. `Recorder.record` is now optional; a recorder must implement one of the
two, and recording refuses one offering neither. The conformance kit drives
either mode.
