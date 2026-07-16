export default {
  base: './',
  build: { target: 'es2022' },
  worker: { format: 'es' }   // terrain worker uses ES module imports
};
