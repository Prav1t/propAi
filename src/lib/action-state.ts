// uniform shape returned by every form server action (shared by client and server)
export type ActionState = {
  ok?: boolean;
  message?: string;
  error?: string;
  fieldErrors?: Record<string, string>;
  values?: Record<string, string>;
  data?: unknown;
};

export const initialActionState: ActionState = {};
