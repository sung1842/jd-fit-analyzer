"""jd-fit-analyzer 채용공고 수집기.

파이프라인: source adapter → JobPosting(정규화) → CSV → COPY fit.job_postings_staging → fit.merge_job_postings() upsert
"""
