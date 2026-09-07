// Redirect ./launch.js to the local stub so tools.js tests never spawn a real
// browser. Matches the relative specifier tools.js resolves (./launch.js).
const MOCK = new URL('./mock-launch.js', import.meta.url).href;

export async function resolve(specifier, context, nextResolve) {
  if (specifier === './launch.js' || specifier.endsWith('/dsh-real-browser/launch.js')) {
    return { url: MOCK, shortCircuit: true };
  }
  return nextResolve(specifier, context);
}
