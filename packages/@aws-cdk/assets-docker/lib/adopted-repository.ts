import cfn = require('@aws-cdk/aws-cloudformation');
import ecr = require('@aws-cdk/aws-ecr');
import iam = require('@aws-cdk/aws-iam');
import lambda = require('@aws-cdk/aws-lambda');
import cdk = require('@aws-cdk/cdk');
import path = require('path');

interface AdoptedRepositoryProps {
  /**
   * An ECR repository to adopt. Once adopted, the repository will
   * practically become part of this stack, so it will be removed when
   * the stack is deleted.
   */
  repositoryName: string;
}

/**
 * An internal class used to adopt an ECR repository used for the locally built
 * image into the stack.
 *
 * Since the repository is not created by the stack (but by the CDK toolkit),
 * adopting will make the repository "owned" by the stack. It will be cleaned
 * up when the stack gets deleted, to avoid leaving orphaned repositories on
 * stack cleanup.
 */
export class AdoptedRepository extends ecr.RepositoryBase {
  public readonly repositoryName: string;
  public readonly repositoryArn: string;

  private readonly policyDocument = new iam.PolicyDocument();

  constructor(parent: cdk.Construct, id: string, private readonly props: AdoptedRepositoryProps) {
    super(parent, id);

    const fn = new lambda.SingletonFunction(this, 'Function', {
      runtime: lambda.Runtime.NodeJS810,
      lambdaPurpose: 'AdoptEcrRepository',
      handler: 'handler.handler',
      code: lambda.Code.asset(path.join(__dirname, 'adopt-repository')),
      uuid: 'dbc60def-c595-44bc-aa5c-28c95d68f62c',
      timeout: 300
    });

    fn.addToRolePolicy(new iam.PolicyStatement()
      .addResource(ecr.Repository.arnForLocalRepository(props.repositoryName))
      .addActions(
        'ecr:GetRepositoryPolicy',
        'ecr:SetRepositoryPolicy',
        'ecr:DeleteRepository',
        'ecr:ListImages',
        'ecr:BatchDeleteImage'
      ));

    const adopter = new cfn.CustomResource(this, 'Resource', {
      resourceType: 'Custom::ECRAdoptedRepository',
      lambdaProvider: fn,
      properties: {
        RepositoryName: props.repositoryName,
        PolicyDocument: this.policyDocument
      }
    });

    // we use the Fn::GetAtt with the RepositoryName returned by the custom
    // resource in order to implicitly create a dependency between consumers
    // and the custom resource.
    this.repositoryName = adopter.getAtt('RepositoryName').toString();

    // this this repository is "local" to the stack (in the same region/account)
    // we can render it's ARN from it's name.
    this.repositoryArn = ecr.Repository.arnForLocalRepository(this.repositoryName);
  }

  /**
   * Export this repository from the stack
   */
  public export() {
    return this.props;
  }

  /**
   * Adds a statement to the repository resource policy.
   *
   * Contrary to normal imported repositories, which no-op here, we can
   * use the custom resource to modify the ECR resource policy if needed.
   */
  public addToResourcePolicy(statement: iam.PolicyStatement) {
    this.policyDocument.addStatement(statement);
  }
}
