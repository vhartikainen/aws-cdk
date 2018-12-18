import { CloudFormationToken, Construct } from "@aws-cdk/cdk";
import { Action } from "./action";

/**
 * An output artifact of an action. Artifacts can be used as input by some actions.
 */
export class Artifact extends Construct {
  constructor(parent: Action, readonly name: string) {
    super(parent, name);
  }

  /**
   * Returns an ArtifactPath for a file within this artifact.
   * Output is in the form "<artifact-name>::<file-name>"
   * @param fileName The name of the file
   */
  public atPath(fileName: string) {
    return new ArtifactPath(this, fileName);
  }

  /**
   * The artifact attribute for the name of the S3 bucket where the artifact is stored.
   */
  public get bucketName() {
    return artifactAttribute(this, 'BucketName');
  }

  /**
   * The artifact attribute for The name of the .zip file that contains the artifact that is
   * generated by AWS CodePipeline, such as 1ABCyZZ.zip.
   */
  public get objectKey() {
    return artifactAttribute(this, 'ObjectKey');
  }

  /**
   * The artifact attribute of the Amazon Simple Storage Service (Amazon S3) URL of the artifact,
   * such as https://s3-us-west-2.amazonaws.com/artifactstorebucket-yivczw8jma0c/test/TemplateSo/1ABCyZZ.zip.
   */
  public get url() {
    return artifactAttribute(this, 'URL');
  }

  /**
   * Returns a token for a value inside a JSON file within this artifact.
   * @param jsonFile The JSON file name.
   * @param keyName The hash key.
   */
  public getParam(jsonFile: string, keyName: string) {
    return artifactGetParam(this, jsonFile, keyName);
  }

  public toString() {
    return this.name;
  }
}

/**
 * A specific file within an output artifact.
 *
 * The most common use case for this is specifying the template file
 * for a CloudFormation action.
 */
export class ArtifactPath {
  constructor(readonly artifact: Artifact, readonly fileName: string) {

  }

  get location() {
    return `${this.artifact.name}::${this.fileName}`;
  }
}

function artifactAttribute(artifact: Artifact, attributeName: string) {
  return new CloudFormationToken(() => ({ 'Fn::GetArtifactAtt': [artifact.name, attributeName] })).toString();
}

function artifactGetParam(artifact: Artifact, jsonFile: string, keyName: string) {
  return new CloudFormationToken(() => ({ 'Fn::GetParam': [artifact.name, jsonFile, keyName] })).toString();
}
