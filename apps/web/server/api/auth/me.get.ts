/** Who the caller is. Returns null rather than 401 so the UI can render a signed-out state. */
export default defineEventHandler(async (event) => {
  const session = await getAppSession(event);
  if (!session) return { user: null };
  return {
    user: {
      id: session.userId,
      displayName: session.displayName,
      email: session.email,
      role: session.role,
      organizationId: session.organizationId,
    },
  };
});
