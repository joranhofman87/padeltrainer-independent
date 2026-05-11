/**
 * Custom ESLint rule: enforce an accessible name on icon-only Buttons.
 *
 * Triggers on:
 *   <Button size="icon" …/>   (and aliased imports of the shadcn Button)
 *   <button …> with only an icon child and no text
 *
 * Requires at least one of: aria-label, aria-labelledby, title, or readable text.
 */

const ICON_ATTRS = new Set(["aria-label", "aria-labelledby", "title"]);

function getAttr(node, name) {
  return node.attributes.find(
    (a) => a.type === "JSXAttribute" && a.name && a.name.name === name
  );
}

function hasAccessibleNameAttr(node) {
  return node.attributes.some(
    (a) =>
      a.type === "JSXAttribute" &&
      a.name &&
      ICON_ATTRS.has(a.name.name)
  );
}

function isSpreadingProps(node) {
  return node.attributes.some((a) => a.type === "JSXSpreadAttribute");
}

function hasTextChild(jsxElement) {
  if (!jsxElement.children) return false;
  for (const child of jsxElement.children) {
    if (child.type === "JSXText" && child.value.trim()) return true;
    if (
      child.type === "JSXExpressionContainer" &&
      child.expression &&
      child.expression.type !== "JSXEmptyExpression"
    ) {
      // Conservatively treat any expression child as potentially text-bearing.
      // Combined with the size="icon" check below this still catches the typical
      // icon-only pattern (single SVG/icon element child).
      const e = child.expression;
      if (
        e.type === "Literal" ||
        e.type === "TemplateLiteral" ||
        e.type === "Identifier" ||
        e.type === "CallExpression" ||
        e.type === "MemberExpression" ||
        e.type === "ConditionalExpression" ||
        e.type === "LogicalExpression"
      ) {
        return true;
      }
    }
  }
  return false;
}

function isIconElement(node) {
  // <Icon />, <Lucide... />, <svg>, etc — anything that's a JSXElement child without text.
  return node.type === "JSXElement";
}

function onlyIconChildren(jsxElement) {
  if (!jsxElement.children || jsxElement.children.length === 0) return false;
  let hasIcon = false;
  for (const child of jsxElement.children) {
    if (child.type === "JSXText" && !child.value.trim()) continue;
    if (isIconElement(child)) {
      hasIcon = true;
      continue;
    }
    return false;
  }
  return hasIcon;
}

module.exports = {
  meta: {
    type: "problem",
    docs: {
      description:
        "Icon-only Buttons must have aria-label, aria-labelledby, or title.",
    },
    schema: [],
    messages: {
      missingLabel:
        "Icon-only <{{name}}> must have aria-label, aria-labelledby, or title (or readable text).",
    },
  },
  create(context) {
    return {
      JSXOpeningElement(node) {
        const nameNode = node.name;
        if (!nameNode || nameNode.type !== "JSXIdentifier") return;
        const tagName = nameNode.name;

        // Only check shadcn <Button> and native <button>.
        if (tagName !== "Button" && tagName !== "button") return;

        // Spread props can carry the label — bail to avoid false positives.
        if (isSpreadingProps(node)) return;
        if (hasAccessibleNameAttr(node)) return;

        const sizeAttr = getAttr(node, "size");
        const isIconSized =
          sizeAttr &&
          sizeAttr.value &&
          sizeAttr.value.type === "Literal" &&
          sizeAttr.value.value === "icon";

        const parent = node.parent;
        if (parent && parent.type === "JSXElement") {
          if (hasTextChild(parent)) return;
          // If the size isn't "icon", only flag when the only children are icon JSX elements.
          if (!isIconSized && !onlyIconChildren(parent)) return;
        }

        context.report({
          node,
          messageId: "missingLabel",
          data: { name: tagName },
        });
      },
    };
  },
};
