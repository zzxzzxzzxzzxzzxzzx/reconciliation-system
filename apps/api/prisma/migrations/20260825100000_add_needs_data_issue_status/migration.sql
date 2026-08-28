-- Extend issue resolution status for records waiting on missing order data.
ALTER TYPE "IssueResolutionStatus" ADD VALUE 'NEEDS_DATA';
