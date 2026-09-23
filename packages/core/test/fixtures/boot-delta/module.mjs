// A stand-in for a route module a server imports at boot: top-level code that
// runs once when the file loads, alongside functions a request handler might
// call later, and one nobody ever calls at all.
export function bootWork() {
  return 'ran at boot';
}
bootWork();

export function neverCalled() {
  return 'dead code';
}

export function calledInTest1() {
  return 'ran in test1';
}

export function calledInTest2() {
  return 'ran in test2';
}
