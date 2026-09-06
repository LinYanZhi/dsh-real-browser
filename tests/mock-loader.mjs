// Mock loader: redirect @deepseek-ai/dsh-tools to a local stub so we can load
// tools.js outside a DSH profile and verify the plugin shape + registration.
const MOCK = new URL('./mock-dsh-tools.js', import.meta.url).href;

export async function resolve(specifier, context, nextResolve) {
  if (specifier === '@deepseek-ai/dsh-tools') {
    return { url: MOCK, shortCircuit: true };
  }
  return nextResolve(specifier, context);
}
