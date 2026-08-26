type ExistingUserForCliProvisioning = {
  platformRole: string | null;
};

export function assertCliUserIsNotPlatformAdmin(
  user: ExistingUserForCliProvisioning | null,
): void {
  if (user?.platformRole) {
    throw new Error(
      "Usuarios de plataforma devem ser administrados pelo bootstrap ou backoffice.",
    );
  }
}
