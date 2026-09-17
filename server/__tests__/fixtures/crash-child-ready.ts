// Shared crash-child handshake. A crash fixture calls readyAndWait at
// its exact protocol seam: it prints READY:<point> on stdout and then
// HANGS until the parent force-kills it. The parent test kills only AFTER
// receiving the READY line, so READY receipt
// is the proof the hook was reached and the disk holds exactly that
// point's state. A child that dies on its own — hook never fired,
// missing env, a bug in the fixture — never prints READY, and the
// parent's waitReady rejects with the exit code and stderr instead of
// a false-positive "hard kill". A self-inflicted kill inside the child
// could never give this guarantee on Windows (TerminateProcess masks
// every non-zero exit as a plausible kill).
export function readyAndWait(point: string): Promise<never> {
  process.stdout.write(`READY:${point}\n`)
  // Safety net: if the parent never kills us, fail loudly with a
  // distinct exit code instead of hanging the suite forever. The timer
  // is deliberately NOT unref'd — it is what keeps the event loop
  // alive while the returned promise hangs.
  setTimeout(() => {
    console.error(`crash child was not killed within 15s after READY:${point}`)
    process.exit(4)
  }, 15000)
  return new Promise<never>(() => {})
}
