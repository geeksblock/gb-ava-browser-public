export interface BuildIdentityInput {
  commit: string;
  dirty: boolean;
  builtAt: string;
}

export interface BuildIdentity {
  id: string;
  builtAt: string;
  clean: boolean;
}

export function deriveBuildIdentity(input: BuildIdentityInput): BuildIdentity;
