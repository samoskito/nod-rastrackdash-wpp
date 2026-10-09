/** Current authorization for an immutable publication intent. Credentials and
 * trigger rules are deliberately excluded: neither revokes a committed sale.
 * Pause/removal of a connection binding, channel, route or Meta asset does.
 */
export type KommoPublicationIntent = {
  connectionId: string;
  routeId: string;
  channelId: string;
  whatsappInstanceId: string;
  destinationId: string;
  pixelId: string;
  pageId: string;
  businessConnectionId: string;
  reportingAccountId: string;
  eventId: string;
};

export async function authorizedKommoRoute(
  client: any,
  workspaceId: string,
  routeId: string,
  intent?: KommoPublicationIntent,
) {
  const route = await client.inboundWebhookChannelRoute.findFirst({
    where: {
      id: routeId,
      workspaceId,
      active: true,
      validationStatus: "valid",
    },
    include: {
      channel: {
        include: {
          whatsappInstance: true,
          connection: { include: { parserRelease: true } },
        },
      },
      metaBusinessConnection: { include: { credential: true } },
      metaReportingAccount: true,
      metaConversionDestination: true,
    },
  });
  const channel = route?.channel;
  const connection = channel?.connection;
  const business = route?.metaBusinessConnection;
  const reporting = route?.metaReportingAccount;
  const destination = route?.metaConversionDestination;
  if (
    !route ||
    channel?.workspaceId !== workspaceId ||
    channel.status !== "active" ||
    !channel.productionActivatedAt ||
    !channel.whatsappInstanceId ||
    channel.whatsappInstance?.workspaceId !== workspaceId ||
    channel.whatsappInstance.status !== "active" ||
    connection?.workspaceId !== workspaceId ||
    connection.removedAt ||
    connection.status !== "production" ||
    !connection.productionActivatedAt ||
    connection.parserRelease?.status !== "certified" ||
    business?.workspaceId !== workspaceId ||
    business.status !== "active" ||
    business.credential?.workspaceId !== workspaceId ||
    business.credential.status !== "active" ||
    reporting?.workspaceId !== workspaceId ||
    !reporting.active ||
    reporting.businessConnectionId !== business.id ||
    destination?.workspaceId !== workspaceId ||
    destination.status !== "configured"
  )
    return null;
  if (
    intent &&
    (channel.id !== intent.channelId ||
      channel.whatsappInstanceId !== intent.whatsappInstanceId ||
      route.metaBusinessConnectionId !== intent.businessConnectionId ||
      route.metaReportingAccountId !== intent.reportingAccountId ||
      route.metaConversionDestinationId !== intent.destinationId ||
      destination.pixelId !== intent.pixelId ||
      destination.pageId !== intent.pageId)
  )
    return null;
  return route;
}

export async function kommoPublicationAuthorized(
  client: any,
  workspaceId: string,
  intent: KommoPublicationIntent,
): Promise<boolean> {
  if (!intent?.connectionId || !intent.routeId) return false;
  const connection = await client.kommoConnection.findFirst({
    where: { id: intent.connectionId, workspaceId, status: "active" },
  });
  if (!connection?.allowedChannelRouteIds.includes(intent.routeId))
    return false;
  return Boolean(
    await authorizedKommoRoute(client, workspaceId, intent.routeId, intent),
  );
}
