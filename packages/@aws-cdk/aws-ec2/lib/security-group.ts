import { Construct, ITaggable, Output, TagManager, Tags, Token } from '@aws-cdk/cdk';
import { Connections, IConnectable } from './connections';
import { CfnSecurityGroup, CfnSecurityGroupEgress, CfnSecurityGroupIngress } from './ec2.generated';
import { IPortRange, ISecurityGroupRule } from './security-group-rule';
import { IVpcNetwork } from './vpc-ref';

export interface ISecurityGroup extends ISecurityGroupRule, IConnectable {
  readonly securityGroupId: string;
  addIngressRule(peer: ISecurityGroupRule, connection: IPortRange, description?: string): void;
  addEgressRule(peer: ISecurityGroupRule, connection: IPortRange, description?: string): void;
  export(): SecurityGroupImportProps;
}

export interface SecurityGroupImportProps {
  /**
   * ID of security group
   */
  securityGroupId: string;
}

/**
 * A SecurityGroup that is not created in this template
 */
export abstract class SecurityGroupBase extends Construct implements ISecurityGroup {
  public abstract readonly securityGroupId: string;
  public readonly canInlineRule = false;
  public readonly connections: Connections = new Connections({ securityGroups: [this] });

  /**
   * FIXME: Where to place this??
   */
  public readonly defaultPortRange?: IPortRange;

  public addIngressRule(peer: ISecurityGroupRule, connection: IPortRange, description?: string) {
    let id = `from ${peer.uniqueId}:${connection}`;
    if (description === undefined) {
      description = id;
    }
    id = id.replace('/', '_');

    // Skip duplicates
    if (this.tryFindChild(id) === undefined) {
      new CfnSecurityGroupIngress(this, id, {
        groupId: this.securityGroupId,
        ...peer.toIngressRuleJSON(),
        ...connection.toRuleJSON(),
        description
      });
    }
  }

  public addEgressRule(peer: ISecurityGroupRule, connection: IPortRange, description?: string) {
    let id = `to ${peer.uniqueId}:${connection}`;
    if (description === undefined) {
      description = id;
    }
    id = id.replace('/', '_');

    // Skip duplicates
    if (this.tryFindChild(id) === undefined) {
      new CfnSecurityGroupEgress(this, id, {
        groupId: this.securityGroupId,
        ...peer.toEgressRuleJSON(),
        ...connection.toRuleJSON(),
        description
      });
    }
  }

  public toIngressRuleJSON(): any {
    return { sourceSecurityGroupId: this.securityGroupId };
  }

  public toEgressRuleJSON(): any {
    return { destinationSecurityGroupId: this.securityGroupId };
  }

  /**
   * Export this SecurityGroup for use in a different Stack
   */
  public abstract export(): SecurityGroupImportProps;
}

export interface SecurityGroupProps {
  /**
   * The name of the security group. For valid values, see the GroupName
   * parameter of the CreateSecurityGroup action in the Amazon EC2 API
   * Reference.
   *
   * It is not recommended to use an explicit group name.
   *
   * @default If you don't specify a GroupName, AWS CloudFormation generates a
   * unique physical ID and uses that ID for the group name.
   */
  groupName?: string;

  /**
   * A description of the security group.
   *
   * @default The default name will be the construct's CDK path.
   */
  description?: string;

  /**
   * The AWS resource tags to associate with the security group.
   */
  tags?: Tags;

  /**
   * The VPC in which to create the security group.
   */
  vpc: IVpcNetwork;

  /**
   * Whether to allow all outbound traffic by default.
   *
   * If this is set to true, there will only be a single egress rule which allows all
   * outbound traffic. If this is set to false, no outbound traffic will be allowed by
   * default and all egress traffic must be explicitly authorized.
   *
   * @default true
   */
  allowAllOutbound?: boolean;
}

/**
 * Creates an Amazon EC2 security group within a VPC.
 *
 * This class has an additional optimization over imported security groups that it can also create
 * inline ingress and egress rule (which saves on the total number of resources inside
 * the template).
 */
export class SecurityGroup extends SecurityGroupBase implements ITaggable {
  /**
   * Import an existing SecurityGroup
   */
  public static import(parent: Construct, id: string, props: SecurityGroupImportProps): ISecurityGroup {
    return new ImportedSecurityGroup(parent, id, props);
  }

  /**
   * An attribute that represents the security group name.
   */
  public readonly groupName: string;

  /**
   * An attribute that represents the physical VPC ID this security group is part of.
   */
  public readonly vpcId: string;

  /**
   * The ID of the security group
   */
  public readonly securityGroupId: string;

  /**
   * Manage tags for this construct and children
   */
  public readonly tags: TagManager;

  private readonly securityGroup: CfnSecurityGroup;
  private readonly directIngressRules: CfnSecurityGroup.IngressProperty[] = [];
  private readonly directEgressRules: CfnSecurityGroup.EgressProperty[] = [];

  private readonly allowAllOutbound: boolean;

  constructor(parent: Construct, name: string, props: SecurityGroupProps) {
    super(parent, name);

    this.tags = new TagManager(this, { initialTags: props.tags});
    const groupDescription = props.description || this.path;

    this.allowAllOutbound = props.allowAllOutbound !== false;

    this.securityGroup = new CfnSecurityGroup(this, 'Resource', {
      groupName: props.groupName,
      groupDescription,
      securityGroupIngress: new Token(() => this.directIngressRules),
      securityGroupEgress: new Token(() => this.directEgressRules),
      vpcId: props.vpc.vpcId,
      tags: this.tags,
    });

    this.securityGroupId = this.securityGroup.securityGroupId;
    this.groupName = this.securityGroup.securityGroupName;
    this.vpcId = this.securityGroup.securityGroupVpcId;

    this.addDefaultEgressRule();
  }

  /**
   * Export this SecurityGroup for use in a different Stack
   */
  public export(): SecurityGroupImportProps {
    return {
      securityGroupId: new Output(this, 'SecurityGroupId', { value: this.securityGroupId }).makeImportValue().toString()
    };
  }

  public addIngressRule(peer: ISecurityGroupRule, connection: IPortRange, description?: string) {
    if (!peer.canInlineRule || !connection.canInlineRule) {
      super.addIngressRule(peer, connection, description);
      return;
    }

    if (description === undefined) {
      description = `from ${peer.uniqueId}:${connection}`;
    }

    this.addDirectIngressRule({
      ...peer.toIngressRuleJSON(),
      ...connection.toRuleJSON(),
      description
    });
  }

  public addEgressRule(peer: ISecurityGroupRule, connection: IPortRange, description?: string) {
    if (this.allowAllOutbound) {
      // In the case of "allowAllOutbound", we don't add any more rules. There
      // is only one rule which allows all traffic and that subsumes any other
      // rule.
      return;
    } else {
      // Otherwise, if the bogus rule exists we can now remove it because the
      // presence of any other rule will get rid of EC2's implicit "all
      // outbound" rule anyway.
      this.removeNoTrafficRule();
    }

    if (!peer.canInlineRule || !connection.canInlineRule) {
      super.addEgressRule(peer, connection, description);
      return;
    }

    if (description === undefined) {
      description = `from ${peer.uniqueId}:${connection}`;
    }

    const rule = {
      ...peer.toEgressRuleJSON(),
      ...connection.toRuleJSON(),
      description
    };

    if (isAllTrafficRule(rule)) {
      // We cannot allow this; if someone adds the rule in this way, it will be
      // removed again if they add other rules. We also can't automatically switch
      // to "allOutbound=true" mode, because we might have already emitted
      // EgressRule objects (which count as rules added later) and there's no way
      // to recall those. Better to prevent this for now.
      throw new Error('Cannot add an "all traffic" egress rule in this way; set allowAllOutbound=true on the SecurityGroup instead.');
    }

    this.addDirectEgressRule(rule);
  }

  /**
   * Add a direct ingress rule
   */
  private addDirectIngressRule(rule: CfnSecurityGroup.IngressProperty) {
    if (!this.hasIngressRule(rule)) {
      this.directIngressRules.push(rule);
    }
  }

  /**
   * Return whether the given ingress rule exists on the group
   */
  private hasIngressRule(rule: CfnSecurityGroup.IngressProperty): boolean {
    return this.directIngressRules.findIndex(r => ingressRulesEqual(r, rule)) > -1;
  }

  /**
   * Add a direct egress rule
   */
  private addDirectEgressRule(rule: CfnSecurityGroup.EgressProperty) {
    if (!this.hasEgressRule(rule)) {
      this.directEgressRules.push(rule);
    }
  }

  /**
   * Return whether the given egress rule exists on the group
   */
  private hasEgressRule(rule: CfnSecurityGroup.EgressProperty): boolean {
    return this.directEgressRules.findIndex(r => egressRulesEqual(r, rule)) > -1;
  }

  /**
   * Add the default egress rule to the securityGroup
   *
   * This depends on allowAllOutbound:
   *
   * - If allowAllOutbound is true, we *TECHNICALLY* don't need to do anything, because
   *   EC2 is going to create this default rule anyway. But, for maximum readability
   *   of the template, we will add one anyway.
   * - If allowAllOutbound is false, we add a bogus rule that matches no traffic in
   *   order to get rid of the default "all outbound" rule that EC2 creates by default.
   *   If other rules happen to get added later, we remove the bogus rule again so
   *   that it doesn't clutter up the template too much (even though that's not
   *   strictly necessary).
   */
  private addDefaultEgressRule() {
    if (this.allowAllOutbound) {
      this.directEgressRules.push(ALLOW_ALL_RULE);
    } else {
      this.directEgressRules.push(MATCH_NO_TRAFFIC);
    }
  }

  /**
   * Remove the bogus rule if it exists
   */
  private removeNoTrafficRule() {
    const i = this.directEgressRules.findIndex(r => egressRulesEqual(r, MATCH_NO_TRAFFIC));
    if (i > -1) {
      this.directEgressRules.splice(i, 1);
    }
  }
}

/**
 * Egress rule that purposely matches no traffic
 *
 * This is used in order to disable the "all traffic" default of Security Groups.
 *
 * No machine can ever actually have the 255.255.255.255 IP address, but
 * in order to lock it down even more we'll restrict to a nonexistent
 * ICMP traffic type.
 */
const MATCH_NO_TRAFFIC = {
  cidrIp: '255.255.255.255/32',
  description: 'Disallow all traffic',
  ipProtocol: 'icmp',
  fromPort: 252,
  toPort: 86
};

/**
 * Egress rule that matches all traffic
 */
const ALLOW_ALL_RULE = {
  cidrIp: '0.0.0.0/0',
  description: 'Allow all outbound traffic by default',
  ipProtocol: '-1',
};

export interface ConnectionRule {
  /**
   * The IP protocol name (tcp, udp, icmp) or number (see Protocol Numbers).
   * Use -1 to specify all protocols. If you specify -1, or a protocol number
   * other than tcp, udp, icmp, or 58 (ICMPv6), traffic on all ports is
   * allowed, regardless of any ports you specify. For tcp, udp, and icmp, you
   * must specify a port range. For protocol 58 (ICMPv6), you can optionally
   * specify a port range; if you don't, traffic for all types and codes is
   * allowed.
   *
   * @default tcp
   */
  protocol?: string;

  /**
   * Start of port range for the TCP and UDP protocols, or an ICMP type number.
   *
   * If you specify icmp for the IpProtocol property, you can specify
   * -1 as a wildcard (i.e., any ICMP type number).
   */
  fromPort: number;

  /**
   * End of port range for the TCP and UDP protocols, or an ICMP code.
   *
   * If you specify icmp for the IpProtocol property, you can specify -1 as a
   * wildcard (i.e., any ICMP code).
   *
   * @default If toPort is not specified, it will be the same as fromPort.
   */
  toPort?: number;

  /**
   * Description of this connection. It is applied to both the ingress rule
   * and the egress rule.
   *
   * @default No description
   */
  description?: string;
}

/**
 * A SecurityGroup that hasn't been created here
 */
class ImportedSecurityGroup extends SecurityGroupBase {
  public readonly securityGroupId: string;

  constructor(parent: Construct, name: string, private readonly props: SecurityGroupImportProps) {
    super(parent, name);

    this.securityGroupId = props.securityGroupId;
  }

  public export() {
    return this.props;
  }
}

/**
 * Compare two ingress rules for equality the same way CloudFormation would (discarding description)
 */
function ingressRulesEqual(a: CfnSecurityGroup.IngressProperty, b: CfnSecurityGroup.IngressProperty) {
  return a.cidrIp === b.cidrIp
    && a.cidrIpv6 === b.cidrIpv6
    && a.fromPort === b.fromPort
    && a.toPort === b.toPort
    && a.ipProtocol === b.ipProtocol
    && a.sourceSecurityGroupId === b.sourceSecurityGroupId
    && a.sourceSecurityGroupName === b.sourceSecurityGroupName
    && a.sourceSecurityGroupOwnerId === b.sourceSecurityGroupOwnerId;
}

/**
 * Compare two egress rules for equality the same way CloudFormation would (discarding description)
 */
function egressRulesEqual(a: CfnSecurityGroup.EgressProperty, b: CfnSecurityGroup.EgressProperty) {
  return a.cidrIp === b.cidrIp
    && a.cidrIpv6 === b.cidrIpv6
    && a.fromPort === b.fromPort
    && a.toPort === b.toPort
    && a.ipProtocol === b.ipProtocol
    && a.destinationPrefixListId === b.destinationPrefixListId
    && a.destinationSecurityGroupId === b.destinationSecurityGroupId;
}

/**
 * Whether this rule refers to all traffic
 */
function isAllTrafficRule(rule: any) {
  return rule.cidrIp === '0.0.0.0/0' && rule.ipProtocol === '-1';
}
