import { sample_builds, sample_functions, sample_modules, sample_types } from "@kernelarchive/shared/sample-data";

console.log(JSON.stringify({
  builds: sample_builds.length,
  modules: sample_modules.length,
  types: sample_types.length,
  functions: sample_functions.length,
}, null, 2));
