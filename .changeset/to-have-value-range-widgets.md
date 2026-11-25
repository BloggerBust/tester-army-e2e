---
"@e2e-dev/web": patch
---

`expect(locator).toHaveValue` reads a `slider`, `spinbutton`, `progressbar`, `meter`, or `scrollbar` that is not a native form control or an editor: its `aria-valuetext`, else its `aria-valuenow`, else the clamped value of a native `<progress>` or `<meter>` with a `value` attribute. A `slider` or `spinbutton` with none reads `''`, as before, and any other widget with none, such as an indeterminate `<progress>`, is refused. `locator.inputValue()` reads the same value. Form controls read as before.
