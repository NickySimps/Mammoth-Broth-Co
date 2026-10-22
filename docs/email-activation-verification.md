# Email activation verification

## Current production state

Automatic order email is enabled. Card payments remain disabled. The user's approved existing SMTP configuration was recovered privately from legacy Firebase runtime configuration; the saved password did not match the checked historical literal credentials. No credential values are recorded here or in Git.

The saved SMTP login authenticated successfully without sending a message. Its password was migrated in memory/stdin to a new enabled Secret Manager version and read back privately for equality. The password is bound as GMAIL_PASS; approved sender/login identifiers are runtime configuration in ignored firebase/functions/.env, not committed source. The legacy configuration was left intact; no existing secret was deleted.

## Binding correction

The initial deployment had COMMERCE_EMAIL_ENABLED=true but no password binding. Raw Cloud Functions API readback caught this; the installed CLI's normalized functions:list output omitted binding metadata entirely. Discovery runs before runtime .env flags are available, so choosing bindings from COMMERCE_EMAIL_ENABLED was incorrect.

Mail secret metadata is now deterministic: GMAIL_PASS is always declared for mail-enabled endpoints after provisioning. Runtime emailEnabled still blocks every send when switched off. Public createPreorder retains zero secret bindings. Stripe remains disabled/unbound. New regression observed RED then GREEN for binding discovery without runtime flags; existing disabled-email tests remain passing.

Five endpoints were redeployed: retryOrderEmail,sendOrderConfirmationEmail,sendOrderEmailOnUpdate,reviewSpecialOrder,resumePaymentSetup. Raw API readback confirmed ACTIVE, emailEnabled=true and GMAIL_PASS version1 for the sender/retry endpoints. All11 deployed functions remained ACTIVE. A fresh project must provision GMAIL_PASS before deploying this release, even if runtime mail is disabled.

## Real end-to-end test

- Used the ordinary mammothbroth.com customer UI with real App Check, one Beef Broth jar, Atlantic Beach pickup and a clearly marked TEST ONLY email-setup customer. Recipient was the approved business inbox; no unrelated customer was contacted and no card charge occurred.
- Confirmation returned Mammoth-ab06bef5; exact order ID ab06bef51cc1e79475c80e226c8c4eafed6ab6ff4dae97e124cd387c6ccd335e.
- Independent Firestore readback: emailState=sent, emailVersion=emailSentVersion=emailCustomerSentVersion=emailOperationsSentVersion=1.
- Read only inbox messages matching that exact test reference over authenticated, readonly IMAP. Exactly two messages were found: one customer copy and one operations copy, with the expected From and To. No unrelated messages were fetched, no message was marked read, and no inbox contents/credentials were logged.
- Decoded each received inline GIF locally with ZXing. Both encoded exactly the staff.html locator for this order, with no guest proof or customer data.
- Cleanup targeted only this test identity/document using update-time preconditions: status=cancelled,isTest=true,receiptRevoked=true, cancellation reason TEST ONLY/do not fulfill. Readback retained sent-version checkpoints. No real order was changed and no old pending orders were bulk retried.

## Checks and limitations

Full Node22.23.4 explicit suite:197 tests,196 passed,0 failed,1 existing optional OpenCV decode skipped. Email tests include offline MIME/inline attachment and per-recipient retry behavior. SMTP acceptance plus inbox arrival is verified for this business-inbox test; other recipient domains/spam filtering cannot be guaranteed. SMTP acceptance followed by a crash before checkpointing may still duplicate on retry, as documented by the existing delivery contract.

GMAIL_PASS must remain in Secret Manager, not dotenv/source/chat. For rotation use the supported firebase functions:secrets:set GMAIL_PASS prompt or a private stdin transfer, redeploy bound endpoints, and verify raw API binding metadata plus a marked test. COMMERCE_EMAIL_ENABLED=false remains a safe runtime kill switch without weakening pickup checkout or deleting the provisioned secret.
