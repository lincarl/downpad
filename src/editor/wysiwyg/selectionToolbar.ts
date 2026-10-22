import { keymapRef, type ToolbarFeatureConfig } from "@milkdown/crepe/feature/toolbar";
import { commandsCtx, editorViewCtx } from "@milkdown/kit/core";
import { headingKeymap, headingSchema, wrapInHeadingCommand } from "@milkdown/kit/preset/commonmark";

type HeadingAction = keyof ReturnType<ReturnType<typeof headingKeymap.key.create>["get"]>;

/** Put heading levels before inline formatting, with math available through the block menu. */
export const selectionToolbar: ToolbarFeatureConfig = {
  buildToolbar(builder) {
    const defaults = builder.build();
    builder.clear();
    const headings = builder.addGroup("headings", "Headings");
    for (const level of [1, 2, 3, 4] as const) {
      headings.addItem(`heading-${level}`, {
        label: `Heading ${level}`,
        icon: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><text x="12" y="17" text-anchor="middle" font-family="inherit" font-size="16" font-weight="600">H${level}</text></svg>`,
        keymap: keymapRef<HeadingAction>(headingKeymap.key, `TurnIntoH${level}`),
        active(ctx) {
          const { doc, selection } = ctx.get(editorViewCtx).state;
          const heading = headingSchema.type(ctx);
          let active = true;
          doc.nodesBetween(selection.from, selection.to, (node) => {
            if (node.isTextblock && (node.type !== heading || node.attrs.level !== level)) active = false;
          });
          return active;
        },
        onRun(ctx) {
          ctx.get(commandsCtx).call(wrapInHeadingCommand.key, level);
        },
      });
    }
    for (const { key, label, items } of defaults) {
      const group = builder.addGroup(key, label);
      for (const item of items) {
        if (item.key !== "latex") group.addItem(item.key, item);
      }
    }
  },
};
