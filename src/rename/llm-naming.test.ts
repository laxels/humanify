import { describe, expect, test } from "bun:test";
import {
  isValidIdentifier,
  sanitizeIdentifier,
  toCamelCase,
  toPascalCase,
  toUpperSnakeCase,
} from "./llm-naming";

describe("isValidIdentifier", () => {
  test("returns true for simple identifiers", () => {
    expect(isValidIdentifier("foo")).toBe(true);
    expect(isValidIdentifier("bar")).toBe(true);
    expect(isValidIdentifier("x")).toBe(true);
  });

  test("returns true for camelCase identifiers", () => {
    expect(isValidIdentifier("fooBar")).toBe(true);
    expect(isValidIdentifier("getUserById")).toBe(true);
  });

  test("returns true for PascalCase identifiers", () => {
    expect(isValidIdentifier("FooBar")).toBe(true);
    expect(isValidIdentifier("UserService")).toBe(true);
  });

  test("returns true for identifiers starting with underscore", () => {
    expect(isValidIdentifier("_foo")).toBe(true);
    expect(isValidIdentifier("_private")).toBe(true);
    expect(isValidIdentifier("__proto")).toBe(true);
  });

  test("returns true for identifiers starting with $", () => {
    expect(isValidIdentifier("$foo")).toBe(true);
    expect(isValidIdentifier("$element")).toBe(true);
  });

  test("returns true for identifiers with numbers", () => {
    expect(isValidIdentifier("foo1")).toBe(true);
    expect(isValidIdentifier("user123")).toBe(true);
    expect(isValidIdentifier("_1")).toBe(true);
  });

  test("returns false for empty string", () => {
    expect(isValidIdentifier("")).toBe(false);
  });

  test("returns false for identifiers starting with numbers", () => {
    expect(isValidIdentifier("1foo")).toBe(false);
    expect(isValidIdentifier("123")).toBe(false);
  });

  test("returns false for identifiers with spaces", () => {
    expect(isValidIdentifier("foo bar")).toBe(false);
    expect(isValidIdentifier("hello world")).toBe(false);
  });

  test("returns false for identifiers with special characters", () => {
    expect(isValidIdentifier("foo-bar")).toBe(false);
    expect(isValidIdentifier("foo.bar")).toBe(false);
    expect(isValidIdentifier("foo@bar")).toBe(false);
  });

  test("returns false for reserved words", () => {
    expect(isValidIdentifier("function")).toBe(false);
    expect(isValidIdentifier("class")).toBe(false);
    expect(isValidIdentifier("const")).toBe(false);
    expect(isValidIdentifier("let")).toBe(false);
    expect(isValidIdentifier("var")).toBe(false);
    expect(isValidIdentifier("if")).toBe(false);
    expect(isValidIdentifier("else")).toBe(false);
    expect(isValidIdentifier("return")).toBe(false);
    expect(isValidIdentifier("import")).toBe(false);
    expect(isValidIdentifier("export")).toBe(false);
    expect(isValidIdentifier("await")).toBe(false);
    expect(isValidIdentifier("async")).toBe(false);
    expect(isValidIdentifier("null")).toBe(false);
    expect(isValidIdentifier("true")).toBe(false);
    expect(isValidIdentifier("false")).toBe(false);
  });
});

describe("sanitizeIdentifier", () => {
  test("returns valid identifiers unchanged", () => {
    expect(sanitizeIdentifier("foo")).toBe("foo");
    expect(sanitizeIdentifier("fooBar")).toBe("fooBar");
    expect(sanitizeIdentifier("_private")).toBe("_private");
  });

  test("removes invalid characters", () => {
    expect(sanitizeIdentifier("foo-bar")).toBe("foobar");
    expect(sanitizeIdentifier("foo.bar")).toBe("foobar");
    expect(sanitizeIdentifier("foo@bar")).toBe("foobar");
  });

  test("removes spaces", () => {
    expect(sanitizeIdentifier("foo bar")).toBe("foobar");
    expect(sanitizeIdentifier("hello world")).toBe("helloworld");
  });

  test("prefixes with underscore if starts with number", () => {
    expect(sanitizeIdentifier("1foo")).toBe("_1foo");
    expect(sanitizeIdentifier("123")).toBe("_123");
  });

  test("returns _unnamed for empty result", () => {
    expect(sanitizeIdentifier("@#%")).toBe("_unnamed");
    expect(sanitizeIdentifier("...")).toBe("_unnamed");
    // $ alone becomes _unnamed since it's not descriptive
    expect(sanitizeIdentifier("$")).toBe("_unnamed");
    expect(sanitizeIdentifier("@#$%")).toBe("_unnamed"); // Only $ left, becomes _unnamed
  });

  test("prefixes reserved words with underscore", () => {
    expect(sanitizeIdentifier("function")).toBe("_function");
    expect(sanitizeIdentifier("class")).toBe("_class");
    expect(sanitizeIdentifier("const")).toBe("_const");
    expect(sanitizeIdentifier("let")).toBe("_let");
    expect(sanitizeIdentifier("var")).toBe("_var");
  });

  test("preserves dollar sign", () => {
    expect(sanitizeIdentifier("$foo")).toBe("$foo");
    expect(sanitizeIdentifier("$element")).toBe("$element");
  });

  test("preserves underscores", () => {
    expect(sanitizeIdentifier("_foo")).toBe("_foo");
    expect(sanitizeIdentifier("__bar")).toBe("__bar");
    expect(sanitizeIdentifier("foo_bar")).toBe("foo_bar");
  });
});

describe("toCamelCase", () => {
  test("converts PascalCase to camelCase", () => {
    expect(toCamelCase("FooBar")).toBe("fooBar");
    expect(toCamelCase("UserService")).toBe("userService");
    expect(toCamelCase("HTTPRequest")).toBe("hTTPRequest"); // Not ideal but consistent
  });

  test("converts UPPER_SNAKE_CASE to camelCase", () => {
    expect(toCamelCase("FOO_BAR")).toBe("fooBar");
    expect(toCamelCase("MAX_COUNT")).toBe("maxCount");
    expect(toCamelCase("API_KEY")).toBe("apiKey");
  });

  test("converts snake_case to camelCase", () => {
    expect(toCamelCase("foo_bar")).toBe("fooBar");
    expect(toCamelCase("user_id")).toBe("userId");
    expect(toCamelCase("get_user_by_id")).toBe("getUserById");
  });

  test("returns camelCase unchanged", () => {
    expect(toCamelCase("fooBar")).toBe("fooBar");
    expect(toCamelCase("userId")).toBe("userId");
  });

  test("returns single-character unchanged", () => {
    expect(toCamelCase("x")).toBe("x");
    expect(toCamelCase("X")).toBe("x");
  });
});

describe("toPascalCase", () => {
  test("converts camelCase to PascalCase", () => {
    expect(toPascalCase("fooBar")).toBe("FooBar");
    expect(toPascalCase("userService")).toBe("UserService");
  });

  test("converts UPPER_SNAKE_CASE to PascalCase", () => {
    expect(toPascalCase("FOO_BAR")).toBe("FooBar");
    expect(toPascalCase("MAX_COUNT")).toBe("MaxCount");
  });

  test("converts snake_case to PascalCase", () => {
    expect(toPascalCase("foo_bar")).toBe("FooBar");
    expect(toPascalCase("user_id")).toBe("UserId");
  });

  test("returns PascalCase unchanged", () => {
    expect(toPascalCase("FooBar")).toBe("FooBar");
    expect(toPascalCase("UserService")).toBe("UserService");
  });

  test("handles single character", () => {
    expect(toPascalCase("x")).toBe("X");
    expect(toPascalCase("X")).toBe("X");
  });
});

describe("toUpperSnakeCase", () => {
  test("converts camelCase to UPPER_SNAKE_CASE", () => {
    expect(toUpperSnakeCase("fooBar")).toBe("FOO_BAR");
    expect(toUpperSnakeCase("maxCount")).toBe("MAX_COUNT");
  });

  test("converts PascalCase to UPPER_SNAKE_CASE", () => {
    expect(toUpperSnakeCase("FooBar")).toBe("FOO_BAR");
    expect(toUpperSnakeCase("UserService")).toBe("USER_SERVICE");
  });

  test("returns UPPER_SNAKE_CASE unchanged", () => {
    expect(toUpperSnakeCase("FOO_BAR")).toBe("FOO_BAR");
    expect(toUpperSnakeCase("MAX_COUNT")).toBe("MAX_COUNT");
  });

  test("handles single character", () => {
    expect(toUpperSnakeCase("x")).toBe("X");
    expect(toUpperSnakeCase("X")).toBe("X");
  });

  test("handles acronyms in middle of word", () => {
    expect(toUpperSnakeCase("getUserID")).toBe("GET_USER_ID");
    expect(toUpperSnakeCase("parseXMLData")).toBe("PARSE_XML_DATA");
  });
});
