# Login and Authentication Skill

Use when the application has sign-in, sign-up or password screens.

Cover, where the feature exists:

- Valid sign-in reaches the expected landing page for each role.
- Wrong password, unknown user, empty fields: a generic message that does not
  reveal whether the user exists.
- Password masking, show/hide toggle, and paste behaviour.
- Account lockout or delay after repeated failures, and recovery afterwards.
- Password rules on sign-up or change: each rule broken on its own.
- Forgot or reset password: link sent, link expires, link used twice.
- Sign-out ends the session: the back button and protected URLs then require
  sign-in again.
- Protected pages opened directly without signing in redirect to sign-in.
- Session expiry while working: the user is asked to sign in again and no data
  is silently lost.
- A user cannot see or change another user's data by changing an id in the URL.

Do not test identity-provider internals (for example a corporate single sign-on
page); test only how this application behaves around them.
