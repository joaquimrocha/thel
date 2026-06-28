import { CoverageReport } from "monocart-coverage-reports";
import { coverageOptions } from "./coverage";

// Clear any stale coverage cache before the run.
export default async function () {
  await new CoverageReport(coverageOptions).cleanCache();
}
