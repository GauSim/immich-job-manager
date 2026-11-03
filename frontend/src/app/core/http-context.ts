import { HttpContextToken } from '@angular/common/http';

/** Set on a request to suppress the error snackbar (e.g. background health polling). */
export const SILENT_ERRORS = new HttpContextToken<boolean>(() => false);
