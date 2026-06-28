import { CoverageReport } from "monocart-coverage-reports";
import { coverageOptions } from "./coverage";

// Merge every test's coverage and write the report.
export default async function () {
  await new CoverageReport(coverageOptions).generate();
}
