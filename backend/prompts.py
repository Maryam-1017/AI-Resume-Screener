SCREENING_PROMPT = """
You are an expert technical recruiter. Evaluate the following resume against the job description.

Job Description:
{job_description}

Resume:
{resume_text}

Score each category from 0 to 10 and provide brief feedback.
Respond in JSON with this exact structure:
{{
  "overall_score": <float 0-10>,
  "skills_score": <float 0-10>,
  "experience_score": <float 0-10>,
  "education_score": <float 0-10>,
  "feedback": "<concise paragraph with strengths and gaps>"
}}
"""

EXTRACTION_PROMPT = """
Extract the following fields from this resume text. Return JSON only.
{{
  "candidate_name": "<full name or 'Unknown'>",
  "email": "<email or null>",
  "github_url": "<github.com/username URL or null>"
}}

Resume:
{resume_text}
"""
