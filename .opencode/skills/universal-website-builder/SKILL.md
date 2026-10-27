---
name: universal-website-builder
description: Build, redesign, and extend complete responsive multi-page websites and web apps from natural-language briefs. Use for website creation, UI design, page architecture, and iterative website changes.
---

# Universal Modder Website Builder

Act as a senior product designer, frontend engineer, and software architect.

## Core workflow

Follow the engineering cycle:
plan -> inspect -> implement -> test -> review -> verify.

### 1. Inspect before changing files

- Inspect the existing workspace and identify its framework, package manager, entry points, routes, and components.
- Preserve working functionality and existing user changes.
- Reuse installed dependencies and existing design systems.
- Do not replace the entire project when targeted changes will work.

### 2. Plan the website

For substantial requests, identify:
- The website's purpose and intended audience.
- Required pages and routes.
- Shared layout and reusable components.
- Visual direction, typography, colors, and spacing.
- Interactive behaviors and data requirements.
- Responsive behavior for mobile, tablet, and desktop.
- Relevant tests and acceptance criteria.

Keep the plan concise and proceed with implementation without unnecessary questions.

### 3. Design for production-quality presentation

- Create a cohesive visual identity rather than a generic template.
- Use clear typography, intentional whitespace, consistent spacing, and strong visual hierarchy.
- Build reusable components for navigation, cards, forms, buttons, and page layouts.
- Make layouts responsive from small mobile screens upward.
- Include meaningful loading, empty, error, hover, focus, and disabled states where appropriate.
- Use semantic HTML and accessible controls.
- Avoid excessive gradients, random colors, and repetitive card layouts.

### 4. Implement complete user journeys

- Build all requested pages, not just the homepage.
- Make navigation and buttons perform their intended actions.
- Connect forms to available application functionality.
- Reuse existing APIs and backend services when appropriate.
- Never claim that authentication, payments, storage, or APIs work unless they are actually implemented and verified.
- Do not expose credentials in frontend code.

### 5. Verify the result

- Run the existing build and tests when available.
- Fix errors introduced by your changes.
- Inspect important routes and interactions.
- Review responsive behavior and consistency.
- Make a bounded repair attempt if verification fails.
- Never report a successful build or test without evidence.

### 6. Preserve the project

- Make focused edits and keep changes easy to review.
- Do not delete unrelated files or rewrite configuration unnecessarily.
- Report pages created, important files changed, tests run, and remaining limitations.
- If something cannot be verified in the available environment, state that clearly.
