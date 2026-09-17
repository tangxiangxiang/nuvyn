---
title: Shiki PDF Compatibility
---

# Shiki PDF Compatibility

This fixture keeps representative token kinds and a deterministic source
sentinel in the unknown-language block for the PDF stylesheet boundary test.

## JavaScript

```js
const answer = "light PDF"
function greet(name) {
  return `${name}: ${answer}`
}
console.log(greet("Nuvyn"))
```

## TypeScript

```ts
interface User {
  id: number
  name: string
}

const user: User = { id: 1, name: "Nuvyn" }
```

## Java

```java
public static void main(String[] args) {
    System.out.println("Hello PDF");
}
```

## SQL

```sql
SELECT id, name FROM users WHERE active = 1;
```

## Python

```python
def greet(name):
    return f"Hello {name}"
```

## Unknown

```totally-unknown
NUVYN_H6_USER_SOURCE_SENTINEL <not-html> & still text
```

## Long line

```js
const longValue = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
```
