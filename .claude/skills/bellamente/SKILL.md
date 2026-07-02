```markdown
# bellamente Development Patterns

> Auto-generated skill from repository analysis

## Overview
This skill introduces the core development patterns and conventions used in the `bellamente` TypeScript codebase. It covers file organization, coding style, commit conventions, and testing patterns to help contributors write consistent, maintainable code.

## Coding Conventions

### File Naming
- Use **camelCase** for all file names.
  - Example: `userProfile.ts`, `dataFetcher.test.ts`

### Import Style
- Use **relative imports** for referencing modules within the project.
  - Example:
    ```typescript
    import { fetchData } from './dataFetcher';
    ```

### Export Style
- Use **named exports** for all modules.
  - Example:
    ```typescript
    // In userProfile.ts
    export function getUserProfile(id: string) { ... }
    ```

### Commit Messages
- Follow **Conventional Commits** with the `feat` prefix for new features.
  - Example:
    ```
    feat: add user profile fetching logic
    ```

## Workflows

### Feature Development
**Trigger:** When adding a new feature  
**Command:** `/feature-development`

1. Create a new file using camelCase naming.
2. Write your TypeScript code using named exports.
3. Use relative imports for dependencies.
4. Write corresponding tests in a `.test.ts` file.
5. Commit changes using the `feat:` prefix and a concise description.

### Writing Tests
**Trigger:** When adding or updating tests  
**Command:** `/write-tests`

1. Create a test file with the same base name as the source file, ending with `.test.ts`.
   - Example: `dataFetcher.test.ts`
2. Write test cases using your preferred testing framework (framework is currently unknown).
3. Ensure all new code is covered by tests.

### Code Review Preparation
**Trigger:** Before submitting a pull request  
**Command:** `/prepare-review`

1. Ensure all files follow camelCase naming.
2. Check that all imports are relative and exports are named.
3. Verify that all new features have corresponding tests.
4. Confirm commit messages use the conventional `feat:` prefix.

## Testing Patterns

- Test files are named with the `.test.ts` suffix and placed alongside the source files.
  - Example:
    ```
    src/
      dataFetcher.ts
      dataFetcher.test.ts
    ```
- The specific testing framework is not detected; follow the project's existing test structure.

## Commands
| Command               | Purpose                                    |
|-----------------------|--------------------------------------------|
| /feature-development  | Start a new feature with proper conventions|
| /write-tests          | Add or update tests for your code          |
| /prepare-review       | Prepare your code for code review          |
```