# Forms and Validation Skill

Use when the application has data-entry forms.

For every field, from its observed or stated constraints:

- **Required**: submit with it empty; with only spaces.
- **Length**: exactly min and max; one below min; one above max (the field may
  block typing past max: verify the value is cut, not silently accepted).
- **Number range**: min, max, just outside both, zero, negative, decimal when
  only whole numbers are allowed, non-numeric text.
- **Format** (email, phone, code, pattern): one valid example, then invalid
  cases that each break one part of the format (missing "@", 9 and 11 digits,
  letters in a digits-only field, lowercase where uppercase is required).
- **Dates**: today, past, future, start after end, invalid dates (31 April).
- **Dropdowns and options**: nothing selected when required; each option that
  changes behaviour (for example a price or extra required field).
- **Checkboxes and toggles**: the effect of each state on other fields or rules.

For the form as a whole:

- Error messages name the field and the problem, and appear next to the field.
- Fixing an error clears the message; valid data entered elsewhere is kept.
- Leading and trailing spaces are trimmed or rejected consistently.
- Special characters and non-Latin text in free-text fields are stored and
  shown correctly, never executed as markup.
- Double-clicking submit creates one record, not two.
- Dependent fields: when one field changes the rules for another (a VIP ticket
  needs an ID, a sick leave over two days needs a certificate), test both sides
  of the condition.
